/*
 * Runtime polyfills for old Android System WebView builds (audit W2B-02).
 *
 * vite builds with `target: "chrome60"`, which only lowers syntax; built-in
 * APIs are not polyfilled. The bundle calls the APIs below, some at module top
 * level (crypto.randomUUID stopped the whole app on WebView 66) and some on
 * core paths (sending media runs crypto.randomUUID inside Promise.allSettled,
 * so a message silently never left). Loaded as a classic script before the
 * module entry, so it runs before any bundle code. ES5 only; each polyfill is
 * installed only when the WebView lacks the API.
 */
(function (w) {
  "use strict";

  function define(target, name, value) {
    if (!target || typeof target[name] === "function") return;
    try {
      Object.defineProperty(target, name, { value: value, configurable: true, writable: true });
    } catch (e) {
      target[name] = value;
    }
  }

  function toInteger(value) {
    var n = Number(value);
    if (n !== n) return 0;
    return n < 0 ? Math.ceil(n) : Math.floor(n);
  }

  var cryptoObj = w.crypto;
  if (cryptoObj && typeof cryptoObj.getRandomValues === "function" && typeof cryptoObj.randomUUID !== "function") {
    define(cryptoObj, "randomUUID", function randomUUID() {
      var bytes = new Uint8Array(16);
      cryptoObj.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      var hex = [];
      for (var i = 0; i < 16; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1));
      return hex.slice(0, 4).join("") + "-" + hex.slice(4, 6).join("") + "-" + hex.slice(6, 8).join("") + "-" +
        hex.slice(8, 10).join("") + "-" + hex.slice(10, 16).join("");
    });
  }

  var P = w.Promise;
  if (P) {
    define(P, "allSettled", function allSettled(items) {
      return P.all(Array.from(items, function (item) {
        return P.resolve(item).then(
          function (value) { return { status: "fulfilled", value: value }; },
          function (reason) { return { status: "rejected", reason: reason }; }
        );
      }));
    });
    define(w, "queueMicrotask", function queueMicrotask(callback) {
      P.resolve().then(callback).catch(function (error) {
        w.setTimeout(function () { throw error; }, 0);
      });
    });
  }

  var AP = w.Array && w.Array.prototype;
  function flatten(source, depth, out) {
    for (var i = 0; i < source.length; i++) {
      if (!(i in source)) continue;
      var item = source[i];
      if (depth > 0 && Array.isArray(item)) flatten(item, depth - 1, out);
      else out.push(item);
    }
    return out;
  }
  define(AP, "flat", function flat(depth) {
    return flatten(Object(this), depth === undefined ? 1 : toInteger(depth), []);
  });
  define(AP, "flatMap", function flatMap(callback, thisArg) {
    return flatten(AP.map.call(Object(this), callback, thisArg), 1, []);
  });
  function at(index) {
    var list = Object(this);
    var len = list.length >>> 0;
    var k = toInteger(index);
    if (k < 0) k += len;
    return k < 0 || k >= len ? undefined : list[k];
  }
  define(AP, "at", at);
  define(AP, "findLast", function findLast(predicate, thisArg) {
    var list = Object(this);
    for (var i = (list.length >>> 0) - 1; i >= 0; i--) {
      if (predicate.call(thisArg, list[i], i, list)) return list[i];
    }
    return undefined;
  });
  define(AP, "findLastIndex", function findLastIndex(predicate, thisArg) {
    var list = Object(this);
    for (var i = (list.length >>> 0) - 1; i >= 0; i--) {
      if (predicate.call(thisArg, list[i], i, list)) return i;
    }
    return -1;
  });
  define(AP, "toSorted", function toSorted(compare) {
    return AP.slice.call(Object(this)).sort(compare);
  });

  var SP = w.String && w.String.prototype;
  define(SP, "at", function (index) { return at.call(String(this), index); });
  define(SP, "replaceAll", function replaceAll(search, replacement) {
    if (search instanceof RegExp) {
      if (search.flags.indexOf("g") === -1) throw new TypeError("replaceAll must be called with a global RegExp");
      return String(this).replace(search, replacement);
    }
    var escaped = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return String(this).replace(new RegExp(escaped, "g"), replacement);
  });
  define(SP, "matchAll", function matchAll(regexp) {
    var rx;
    if (regexp instanceof RegExp) {
      if (regexp.flags.indexOf("g") === -1) throw new TypeError("matchAll must be called with a global RegExp");
      rx = new RegExp(regexp.source, regexp.flags);
      rx.lastIndex = regexp.lastIndex;
    } else {
      rx = new RegExp(regexp, "g");
    }
    var text = String(this);
    var matches = [];
    var match;
    while ((match = rx.exec(text)) !== null) {
      matches.push(match);
      if (match[0] === "") rx.lastIndex++;
    }
    return matches[Symbol.iterator]();
  });

  define(w.Object, "fromEntries", function fromEntries(entries) {
    var result = {};
    Array.from(entries, function (entry) { result[entry[0]] = entry[1]; });
    return result;
  });
  define(w.Object, "hasOwn", function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(Object(target), key);
  });

  if (w.AbortController && w.AbortSignal) {
    define(w.AbortSignal, "timeout", function timeout(ms) {
      var controller = new w.AbortController();
      w.setTimeout(function () {
        var reason;
        try { reason = new w.DOMException("signal timed out", "TimeoutError"); } catch (e) { reason = undefined; }
        controller.abort(reason);
      }, ms);
      return controller.signal;
    });
  }
})(window);
