'use strict';

var isRef = require('ssb-ref')
var isHash = isRef.isHash
var isFeedId = isRef.isFeedId
var contpara = require('cont').para
var explain = require('explain-error')
// make a validation stream?
// read the latest record in the database
// check it against the incoming data,
// and then read through

function clone (obj) {
  var o = {}
  for(var k in obj) o[k] = obj[k];
  return o
}

function get (db, key) {
  return function (cb) {
    return db.get(key, cb)
  }
}

function isString (s) {
  return 'string' === typeof s
}

function isInteger (n) {
  return ~~n === n
}

function isObject (o) {
  return o && 'object' === typeof o
}

module.exports = function (ssb, opts) {

  var lastDB = ssb.sublevel('lst')
  var clockDB = ssb.sublevel('clk')
  var hash = opts.hash
  var zeros = undefined

  var verify = opts.keys.verify
  var encode = opts.codec.encode

  var validators = {}

  function validateSync (msg, prev, pub) {
    // :TODO: is there a faster way to measure the size of this message?
    var asJson = JSON.stringify(msg)
    if (asJson.length > 8192) { // 8kb
      validateSync.reason = 'encoded message must not be larger than 8192 bytes'
      return false
    }

    var type = msg.content.type
    if(!isString(type)) {
      validateSync.reason = 'type property must be string'
      return false
    }

    if(52 < type.length || type.length < 3) {
      validateSync.reason = 'type must be 3 < length <= 52, but was:' + type.length
      return false
    }

    if(prev) {
      if(msg.previous !== hash(encode(prev))) {

        validateSync.reason = 'expected previous: '
          + hash(encode(prev)).toString('base64')

        return false
      }
      if(msg.sequence !== prev.sequence + 1
       || msg.timestamp <= prev.timestamp) {

          validateSync.reason = 'out of order'

          return false
      }
    }
    else {
      if(!(msg.previous == null
        && msg.sequence === 1 && msg.timestamp > 0)) {

          validateSync.reason = 'expected initial message'

          return false
      }
    }

    var _pub = pub.public || pub
    if(!(msg.author === _pub || msg.author === hash(_pub))) {

      validateSync.reason = 'expected different author:'+
        hash(pub.public || pub).toString('base64') +
        'but found:' +
        msg.author.toString('base64')

      return false
    }

    var _msg = clone(msg)
    delete _msg.signature
    if(!verify(pub, msg.signature, hash(encode(_msg)))) {

      validateSync.reason = 'signature was invalid'

      return false
    }
    validateSync.reason = ''
    return true
  }

  function getLatest (id, cb) {
    var pub
    contpara([
      ssb.getPublicKey(id),
      get(lastDB, id)
    ])(function (err, results) {
      //get PUBLIC KEY out of FIRST MESSAGE.
      pub = err ? null : results[0]
      var expected = err ? 0 : results[1]
      if(!expected) {
        return cb(null, {
          key: null, value: null, type: 'put',
          public: pub, ready: true
        })
      }

      get(clockDB, [id, expected]) (function (err, key) {
        if(err) throw explain(err, 'this should never happen')
        get(ssb, key) (function (err, _prev) {
          if(err) throw explain(err, 'this should never happen')
          cb(null, {
            key: key, value: _prev, type: 'put',
            public: pub, ready: true
          })
        })
      })
    })
  }

  var latest = {}, authors = {}

  var queue = [], batch = []

  function setLatest(id) {
    if(latest[id]) return
    latest[id] = {
      key: null, value: null, type: 'put',
      public: null, ready: false
    }
    getLatest(id, function (_, obj) {
      latest[id] = obj
      validate()
    })
  }

  var batch = [], writing = false

  function drain () {
    writing = true
    var _batch = batch
    batch = []

    ssb.batch(_batch, function () {
      writing = false
      if(batch.length) drain()
      _batch.forEach(function (op) {
        op.cb(null, op.value, op.key)
      })
      validate()
    })
  }

  function write (op) {
    batch.push(op)
    if(!writing) drain()
  }

  function validate() {
    if(!queue.length) return

    var next = queue[0]
    var id = next.value.author

    //todo, validate as many feeds as possible
    //in parallel. this code currently will wait
    //to get the latest key when necessary
    //which will slow validation when that happens.

    //I will leave it like this currently,
    //because it's hard to test all the edgecases here
    //so optimize for simplicity.

    if(!latest[id]) setLatest(id)
    else if(latest[id].ready) {
      var op = queue.shift()
      var next = op.value
      var l = latest[id]
      var pub = l.public
      var prev = l.value

      if(!pub && !prev && next.content.type === 'init') {
        l.key = op.key
        l.value = op.value
        l.public = next.content.public
        write(op)
      }
      else if(prev.sequence + 1 === next.sequence) {
        if(validateSync(next, prev, pub)) {
          l.key = op.key
          l.value = op.value
          write(op)
        }
        else {
          op.cb(new Error(validateSync.reason))
          drain()
        }
      }
      else if(prev.sequence >= next.sequence) {
        ssb.get(op.key, op.cb)
      } else {
        op.cb(new Error('seq too high'))
        drain()
      }
    }
  }

  function createValidator (id, done) {
    return function (msg, cb) {
      queue.push({
        key: hash(encode(msg)),
        value: msg, type: 'put', cb: cb
      })
      validate()
    }
  }

  var v
  return v = {
    validateSync: validateSync,
    getLatest: getLatest,
    validate: function (msg, cb) {


      if(
        !isObject(msg) ||
        !isInteger(msg.sequence) ||
        !isFeedId(msg.author) ||
        !isObject(msg.content)
      )
        return cb(new Error('invalid message'))



      var id = msg.author
      var validator = validators[id] =
        validators[id] || createValidator(id)

      return validator(msg, cb)
    }
  }
}
