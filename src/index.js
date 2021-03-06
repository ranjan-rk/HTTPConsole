'use strict';

var compression     = require('compression');
var cookieParser    = require('cookie-parser');
var debug           = require('debug')('httpconsole');
var dicer           = require('dicer');
var express         = require('express');
var HARSchema       = require('../schema.json');
var methodOverride  = require('method-override');
var morgan          = require('morgan');
var pkg             = require('../package.json');
var qs              = require('qs');
var redis           = require('redis');
var responseTime    = require('response-time');
var tv4             = require('tv4');
var typer           = require('media-typer');
var url             = require('url');
var util            = require('util');
var uuid            = require('node-uuid');
var XML             = require('jsontoxml');
var YAML            = require('yamljs');

// load .env
require('dotenv').load();

var objectToArray = function (obj) {
  if (!obj || typeof obj !== 'object') {
    return [];
  }

  var name;
  var results = [];
  var names = Object.keys(obj);

  while (name = names.pop()) {
    results.push({
      name: name,
      value: obj[name]
    });
  }

  return results;
};

var createHar = function (req) {
  var getReqHeaderSize = function () {
    var keys = Object.keys(req.headers);

    var values = keys.map(function (key) {
      return req.headers[key];
    });

    var headers = req.method + req.url + req.versionMajor + req.versionMinor + keys.join() + values.join();

    // startline: [method] [url] HTTP/1.1\r\n = 12
    // endline: \r\n = 2
    // every header + \r\n = * 2
    return new Buffer(headers).length + (keys.length * 2) + 12 + 2;
  };

  return {
    log: {
      version: '1.2',
      creator: {
        name: 'httpconsole.com',
        version: pkg.version
      },
      entries: [{
        startedDateTime: new Date().toISOString(),
        clientIPAddress: req.ip,
        request: {
          method: req.method,
          url: req.protocol + '://' + req.hostname + req.originalUrl,
          httpVersion: 'HTTP/1.1',
          // TODO, add cookie details
          cookies: objectToArray(req.cookies),
          headers: objectToArray(req.headers),
          queryString: objectToArray(req.query),
          // TODO
          postData: {
            mimeType: req.contentType ? req.contentType : 'application/octet-stream',
            text: req.body,
            params: []
          },
          headersSize: getReqHeaderSize(),
          bodySize: req.rawBody.length
        }
      }]
    }
  };
};

var HTTPConsole = function (options) {
  if (!(this instanceof HTTPConsole)) {
    return new HTTPConsole(options);
  }

  this.options = options || {};

  this.config = {
    port: this.options.port || process.env.PORT || process.env.npm_package_config_port,
    port_mask: this.options.port || process.env.PORT_MASK || process.env.npm_package_config_port_mask,
    redis: this.options.redis || process.env.REDIS || process.env.REDISCLOUD_URL || process.env.npm_package_config_redis,
    quiet: this.options.quiet || process.env.QUIET
  };

  if (!this.config.redis) {
    throw Error('no redis config');
  }

  // parse redis dsn
  var dsn = url.parse(this.config.redis);

  // connect to redis
  this.redis = redis.createClient(dsn.port, dsn.hostname, {
    auth_pass: dsn.auth ? dsn.auth.split(':').pop() : false
  });

  this.redis.on('error', function (err) {
    debug('redis error:', err);
  });

  // TV4 setup
  tv4.addSchema(HARSchema);
};

HTTPConsole.prototype.createServer = function () {
  // express setup
  this.express = express();
  this.express.set('json spaces', 2);
  this.express.set('jsonp callback name', '__callback');
  this.express.set('view engine', 'jade');
  this.express.enable('view cache');
  this.express.enable('trust proxy');
  this.express.disable('x-powered-by');
  this.express.disable('etag');

  // add 3rd party middlewares
  this.express.use(responseTime());
  this.express.use(methodOverride('X-HTTP-Method-Override'));
  this.express.use(methodOverride('_method'));
  this.express.use(cookieParser());
  this.express.use(compression());

  if (!this.config.quiet) {
    this.express.use(morgan('dev'));
  }

  // define static files path
  this.express.use('/static', express.static(__dirname + '/../static'));

  // add httpconsole middlewares
  this.express.use(this.utilMiddleware);
  this.express.use(this.bodyParser);

  this.express.use(this.notFoundHandler);

  // setup main routes
  this.express.use(this.router());

  // error Handling
  this.express.use(this.errorHandler);

  // negotiate content at the end
  this.express.use(this.negotiateContent);

  // jade locals
  this.express.locals.YAML = YAML;
  this.express.locals.XML = XML;

  return this;
};

HTTPConsole.prototype.bodyParser = function (req, res, next) {
  req.bodyChunks = [];

  req.on('data', function (chunk) {
    req.bodyChunks.push(chunk);
  });

  req.on('end', function () {
    req.rawBody = Buffer.concat(req.bodyChunks);
    req.body = req.rawBody.toString('utf8');
    req.bodySize = req.rawBody.length;
    req.jsonBody = null;
    req.formBody = null;
    req.contentType = null;

    // parse Content-Type
    var type = req.headers['content-type'] ? typer.parse(req) : null;

    if (type) {
      req.contentType = [[type.type, type.subtype].join('/'), type.suffix].join('+').replace(/\+$/, '');
    }

    // create HAR Object
    req.har = createHar(req);

    // json
    switch (req.contentType) {
      case 'application/json':
        try {
          req.jsonBody = JSON.parse(req.body);
        } catch (exception) {}

        next();
        break;

      case 'application/x-www-form-urlencoded':
        req.formBody = qs.parse(req.body);

        // update HAR object
        req.har.log.entries[0].request.postData.params = objectToArray(req.formBody);

        next();
        break;

      case 'multipart/form-data':
        var stream = require('stream');
        var liner = new stream.Transform();

        req.multiPartData = [];
        req.multiPartParams = [];

        // parse a file upload
        var dice = new dicer({
          boundary: type.parameters.boundary
        });

        dice.on('part', function (part) {
          part.on('data', function (data) {
            req.multiPartData.push(data.toString('utf8'));
          });

          part.on('header', function (headers) {
            var param = {};

            if (headers['content-disposition']) {
              var disposition = typer.parse(headers['content-disposition'][0].replace('form-data', 'form-data/text'));

              param.name = disposition.parameters.name;

              if (disposition.parameters.filename) {
                param.fileName = disposition.parameters.filename;
              }
            }

            if (headers['content-type']) {
              var type = typer.parse(headers['content-type'][0]);

              param.contentType = [[type.type, type.subtype].join('/'), type.suffix].join('+').replace(/\+$/, '');
            }

            req.multiPartParams.push(param);
          });
        });

        dice.on('finish', function () {
          req.multiPart = req.multiPartParams.map(function (param, index) {
            param.value = req.multiPartData[index];
            return param;
          });

          // update HAR object
          req.har.log.entries[0].request.postData.params = req.multiPart ? req.multiPart : [];

          next();
        });

        liner.pipe(dice);
        liner.push(req.body);
        break;

      default:
        next();
    }
  });
};

HTTPConsole.prototype.negotiateContent = function (req, res, next) {
  if (typeof res.body !== 'object') {
    res.bodyXmlObj = {
      result: res.body
    };

    res.locals.bodyXmlObj = res.bodyXmlObj;
  }

  res.format({
    json: function () {
      res.jsonp(res.body);
    },

    xml: function () {
      res.send(XML(res.bodyXmlObj || res.body, {
        prettyPrint: true,
        indent: '  '
      }).trim());
    },

    html: function () {
      if (res.view) {
        return res.render(res.view, {
          data: res.body
        });
      }

      res.send(YAML.stringify(res.body, 3, 2));
    },

    default: function () {
      if (typeof res.body === 'string') {
        return res.send(res.body);
      }

      res.send(YAML.stringify(res.body, 6, 2));
    }
  });

  next();
};

HTTPConsole.prototype.utilMiddleware = function (req, res, next) {
  res.locals.path = req.path;
  res.locals.hostname = req.hostname;

  res.set('X-Powered-By', 'httpconsole.com');

  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', '*');
  res.header('Access-Control-Allow-Headers', '*');

  next();
};

HTTPConsole.prototype.notFoundHandler = function (req, res, next) {
  res.status(404);

  res.view = 404;
  res.body = {
    error: {
      code: '404',
      message: 'Not Found'
    }
  };

  next();
};

HTTPConsole.prototype.errorHandler = function (err, req, res, next) {
  debug(err);

  res.status(err.status || 500).view = 'error';

  next();
};

HTTPConsole.prototype.router = function () {
  var self = this;

  var router = express.Router();

  router.get('/', function (req, res, next) {
    res.status(200);

    res.view = 'index';
    res.body = 'Hello World!';

    next();
  });

  router.all('/ip', function (req, res, next) {
    res.status(200);

    res.view = 'default';
    res.body = req.ip;

    next();
  });

  router.all('/ips', function (req, res, next) {
    res.status(200);

    res.view = 'default';
    res.body = req.ips;

    next();
  });

  router.all('/agent', function (req, res, next) {
    res.status(200);

    res.view = 'default';
    res.body = req.headers['user-agent'];

    next();
  });

  router.all('/status/:code/:reason?', function (req, res, next) {
    res.view = 'default';

    res.statusCode = req.params.code || 200;
    res.statusMessage = (req.params.reason || 'OK').replace(/\+/g, ' ');

    res.body = {
      code: res.statusCode,
      message: res.statusMessage
    };

    next();
  });

  router.all('/headers', function (req, res, next) {
    res.status(200);

    res.view = 'default';

    res.body = {
      headers: req.har.log.entries[0].request.headers,
      headersSize: req.har.log.entries[0].request.headersSize
    };

    next();
  });

  router.all('/header/:name', function (req, res, next) {
    res.status(200);

    res.view = 'default';
    res.body = req.headers[req.params.name.toLowerCase()];

    next();
  });

  router.all('/cookies', function (req, res, next) {
    res.status(200);

    res.view = 'default';

    res.body = req.har.log.entries[0].request.cookies;

    next();
  });

  router.all('/cookie/:name', function (req, res, next) {
    res.status(200);

    res.view = 'default';
    res.body = req.cookies[req.params.name.toLowerCase()];

    next();
  });

  router.all('/redirect/:status_code/:count?', function (req, res, next) {
    var count = req.params.count ? parseInt(req.params.count) : 1;
    var status = parseInt(req.params.status_code) || 302;
    var valid = [300, 301, 302, 303, 307, 308];

    if (!~valid.indexOf(status)) {
      res.body = {
        error: 'invalid status code, must be one of ' + valid.join()
      };

      return next();
    }

    if (count > 0) {
      if (count === 1 && req.query.to) {
        return res.redirect(status, req.query.to);
      }

      return res.redirect(status, util.format('http://%s:%s/redirect/%d/%d%s', req.hostname, self.config.port_mask || self.config.port, status, count - 1, req.query.to ? '?to=' + req.query.to : ''));
    }

    res.status(200);

    res.view = 'default';
    res.body = 'redirect finished';

    next();
  });

  router.all('/echo', function (req, res, next) {
    res.status(200);

    res.view = 'default';
    res.locals.yamlInline = 6;

    res.body = req.har;

    next();
  });

  router.all('/gzip', function (req, res, next) {
    res.status(200);

    res.view = 'default';
    res.locals.yamlInline = 6;

    // force compression
    req.headers['accept-encoding'] = 'gzip';
    res.body = req.har;

    next();
  });

  // TODO display web form
  router.get('/bucket/create', function (req, res, next) {
    res.status(200);

    res.view = 'bucket/create';

    next();
  });

  router.post('/bucket/create', function (req, res, next) {
    var id = uuid.v4();

    var result = tv4.validateResult(req.jsonBody, HARSchema.definitions.response);

    if (!result.valid) {
      res.status(400).body = {
        error: {
          code: result.error.code,
          message: result.error.message,
          params: result.error.params,
          dataPath: result.error.dataPath,
          schemaPath: result.error.schemaPath
        }
      };

      return next();
    }

    self.redis.set(id, JSON.stringify(req.jsonBody));

    res.status(201);

    // send back the newly created id
    res.body = util.format('http://%s:%s/bucket/%s', req.hostname, self.config.port_mask || self.config.port, id);
    res.location(res.body);

    next();
  });

  router.get('/bucket/:uuid/view', function (req, res, next) {
    self.redis.get(req.params.uuid, function (err, value) {
      if (err) {
        throw(err);
      }

      if (value) {
        var har = JSON.parse(value);

        res.status(200);

        res.view = 'bucket/view';
        res.body = har;
      }

      next();
    });
  });

  router.all('/bucket/:uuid', function (req, res, next) {
    self.redis.get(req.params.uuid, function (err, value) {
      if (err) {
        throw(err);
      }

      if (value) {
        var har = JSON.parse(value);

        // log interaction & send the appropriate response based on HAR
        self.redis.rpush(req.params.uuid + '-log', JSON.stringify(req.har.log.entries[0]));
        self.redis.ltrim(req.params.uuid + '-log', 0, 100);

        // headers
        har.headers.map(function (header) {
          res.set(header.name, header.value);
        });

        // cookies
        har.cookies.map(function (cookie) {
          res.cookie(cookie.name, cookie.value);
        });

        // status
        res.httpVersion = har.httpVersion.split('/')[1];
        res.statusCode = har.status || 200;
        res.statusMessage = har.statusText || 'OK';

        // special condition
        if (har.redirectURL !== '') {
          res.location(har.redirectURL);
        }

        return res.send(har.content.text ? har.content.text : null);
      }

      next();
    });
  });

  router.get('/bucket/:uuid/log', function (req, res, next) {
    res.status(200);

    res.view = 'bucket/log';

    self.redis.lrange(req.params.uuid + '-log', 0, -1, function (err, history) {
      if (err) {
        throw(err);
      }

      res.body = {
        log: {
          version: '1.2',
          creator: {
            name: 'httpconsole.com',
            version: pkg.version
          },
          entries: []
        }
      };

      if (history.length) {
        res.body.log.entries = history.map(function (request) {
          return JSON.parse(request);
        });
      }

      next();
    });
  });

  router.get('/docs', function (req, res, next) {
    res.status(200);

    res.view = 'docs';
    res.body = {
      error: {
        code: 406,
        message: util.format('please visit, http://%s:%s/docs with a web browser', req.hostname, self.config.port_mask || self.config.port)
      }
    };

    next();
  });

  return router;
};

HTTPConsole.prototype.start = function () {
  // start listening
  this.instance = this.express.listen(this.config.port);

  debug('server listening on port ', this.config.port);

  return HTTPConsole;
};

HTTPConsole.prototype.stop = function () {
  if (this.instance) {
    debug('Stopping server');

    this.instance.close();
  }

  return this;
};

// expose
module.exports = HTTPConsole;
