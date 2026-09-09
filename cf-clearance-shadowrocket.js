// cf-clearance.js v1.2.0
// Cloudflare Clearance 绕过脚本 for Shadowrocket
//
// 工作模式：
// 1. Safari 手动完成 Cloudflare 验证
// 2. 捕获并缓存 cf_clearance、完整 Cookie 和 UA
// 3. 给第三方 App 请求注入已缓存的浏览器身份
// 4. 检测 403/503，失效后通知重新过盾

var CF = {};

CF.VERSION = '1.2.0';

CF.CONFIG = {
  STORE_PREFIX: 'cf_clearance_',
  NOTIFY_THROTTLE_MS: 60000,
  CHALLENGE_STATUS: [403, 503],
  NOTIFY_TITLE: 'CF 盾',
  PROTECT_WINDOW: 30000,

  SAFARI_NAV_HEADERS: {
    'Accept':
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh-Hans;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Connection': 'keep-alive',
    'Priority': 'u=0'
  },

  HEADER_ORDER: [
    'Host',
    'Accept',
    'Upgrade-Insecure-Requests',
    'User-Agent',
    'Accept-Language',
    'Accept-Encoding',
    'Connection',
    'Cookie',
    'Sec-Fetch-Dest',
    'Sec-Fetch-Mode',
    'Sec-Fetch-Site',
    'Priority',
    'Referer',
    'Origin'
  ],

  COOKIE_BLACKLIST: [
    '_ym_isad'
  ],

  COOKIE_PREFIX_BLACKLIST: [
    '_ym_'
  ],

  HEADER_WHITELIST: [
    'host',
    'cookie',
    'user-agent',
    'accept',
    'accept-language',
    'accept-encoding',
    'upgrade-insecure-requests',
    'connection',
    'referer',
    'origin',
    'sec-fetch-dest',
    'sec-fetch-mode',
    'sec-fetch-site',
    'priority',
    'x-requested-with'
  ],

  FALLBACK_UA_VERSION: '17_0',
  FALLBACK_UA_VERSION_DOTTED: '17.0'
};

// ================= Header 辅助 =================

CF.getHeaderCI = function (headers, name) {
  if (!headers) return '';

  var lower = String(name).toLowerCase();
  var keys = Object.keys(headers);

  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lower) {
      return headers[keys[i]];
    }
  }

  return '';
};

CF.removeHeaderCI = function (headers, name) {
  if (!headers) return;

  var lower = String(name).toLowerCase();
  var keys = Object.keys(headers);

  for (var i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === lower) {
      delete headers[keys[i]];
    }
  }
};

CF.setHeaderCI = function (headers, name, value) {
  CF.removeHeaderCI(headers, name);
  headers[name] = value;
};

// ================= 域名与 URL =================

CF.registrableDomain = function (host) {
  if (!host) return '';

  host = String(host).toLowerCase();
  var parts = host.split('.');

  if (parts.length <= 2) return host;

  return parts.slice(-2).join('.');
};

CF.hostFromUrl = function (url) {
  if (!url || typeof url !== 'string') return '';

  var protocolIndex = url.indexOf('://');
  if (protocolIndex < 0) return '';

  var rest = url.slice(protocolIndex + 3);
  var slashIndex = rest.indexOf('/');

  if (slashIndex >= 0) {
    rest = rest.slice(0, slashIndex);
  }

  var atIndex = rest.lastIndexOf('@');
  if (atIndex >= 0) {
    rest = rest.slice(atIndex + 1);
  }

  if (rest.charAt(0) === '[') {
    var ipv6End = rest.indexOf(']');
    if (ipv6End >= 0) {
      return rest.slice(1, ipv6End).toLowerCase();
    }
  }

  var colonIndex = rest.indexOf(':');
  if (colonIndex >= 0) {
    rest = rest.slice(0, colonIndex);
  }

  return rest.toLowerCase();
};

CF.schemeFromUrl = function (url) {
  if (!url || typeof url !== 'string') return '';

  var index = url.indexOf('://');
  if (index < 0) return '';

  return url.slice(0, index).toLowerCase();
};

CF.originFromUrl = function (url) {
  if (!url || typeof url !== 'string') return '';

  var protocolIndex = url.indexOf('://');
  if (protocolIndex < 0) return '';

  var rest = url.slice(protocolIndex + 3);
  var slashIndex = rest.indexOf('/');

  if (slashIndex < 0) {
    var queryIndex = rest.indexOf('?');
    var hashIndex = rest.indexOf('#');
    var end = rest.length;

    if (queryIndex >= 0 && queryIndex < end) end = queryIndex;
    if (hashIndex >= 0 && hashIndex < end) end = hashIndex;

    return url.slice(0, protocolIndex + 3 + end);
  }

  return url.slice(0, protocolIndex + 3 + slashIndex);
};

CF.sanitizeReferer = function (refererValue, targetUrl) {
  if (!refererValue) {
    return {
      value: refererValue,
      send: true
    };
  }

  var hashIndex = refererValue.indexOf('#');
  var stripped =
    hashIndex >= 0
      ? refererValue.slice(0, hashIndex)
      : refererValue;

  var sourceScheme = CF.schemeFromUrl(refererValue);

  if (!sourceScheme) {
    return {
      value: refererValue,
      send: true
    };
  }

  var targetScheme = CF.schemeFromUrl(targetUrl);

  if (sourceScheme === 'https' && targetScheme === 'http') {
    return {
      value: '',
      send: false
    };
  }

  var sourceHost = CF.hostFromUrl(refererValue);
  var targetHost = CF.hostFromUrl(targetUrl);

  if (sourceHost && sourceHost === targetHost) {
    return {
      value: stripped,
      send: true
    };
  }

  return {
    value: CF.originFromUrl(refererValue),
    send: true
  };
};

CF.deriveSecFetchSite = function (
  refererHeader,
  originHeader,
  targetHost
) {
  var sourceHost =
    CF.hostFromUrl(refererHeader) ||
    CF.hostFromUrl(originHeader);

  if (!sourceHost) return 'none';

  if (sourceHost === targetHost) {
    return 'same-origin';
  }

  if (
    CF.registrableDomain(sourceHost) ===
    CF.registrableDomain(targetHost)
  ) {
    return 'same-site';
  }

  return 'cross-site';
};

// ================= Cookie =================

CF.visitKey = function (domain) {
  return 'cf_visit_' + domain.replace(/\./g, '_');
};

CF.notifyThrottleKey = function (domain) {
  return 'cf_notify_' + domain.replace(/\./g, '_');
};

CF.notifyThrottled = function (domain) {
  try {
    var key = CF.notifyThrottleKey(domain);
    var last =
      parseInt($persistentStore.read(key), 10) || 0;
    var now = Date.now();

    if (
      now - last <
      CF.CONFIG.NOTIFY_THROTTLE_MS
    ) {
      return false;
    }

    $persistentStore.write(String(now), key);
    return true;
  } catch (e) {
    return true;
  }
};

CF.extractClearance = function (cookieHeader) {
  if (
    !cookieHeader ||
    typeof cookieHeader !== 'string'
  ) {
    return null;
  }

  var match = cookieHeader.match(
    /(?:^|;\s*)cf_clearance=([^;]+)/
  );

  return match ? match[1] : null;
};

CF.scrubCookie = function (cookieHeader) {
  if (
    !cookieHeader ||
    typeof cookieHeader !== 'string'
  ) {
    return cookieHeader || '';
  }

  var blacklist =
    CF.CONFIG.COOKIE_BLACKLIST;
  var prefixes =
    CF.CONFIG.COOKIE_PREFIX_BLACKLIST;
  var kept = [];
  var parts = cookieHeader.split(';');

  for (var i = 0; i < parts.length; i++) {
    var segment = parts[i].trim();
    if (!segment) continue;

    var equalIndex = segment.indexOf('=');
    var name =
      equalIndex >= 0
        ? segment.slice(0, equalIndex)
        : segment;

    var lowerName = name.toLowerCase();

    if (blacklist.indexOf(lowerName) >= 0) {
      continue;
    }

    var blocked = false;

    for (var j = 0; j < prefixes.length; j++) {
      if (
        lowerName.slice(0, prefixes[j].length) ===
        prefixes[j]
      ) {
        blocked = true;
        break;
      }
    }

    if (!blocked) {
      kept.push(segment);
    }
  }

  return kept.join('; ');
};

// ================= Header 排序 =================

CF.orderHeaders = function (headers) {
  if (!headers) return {};

  var orderIndex = CF.orderIndex;
  var tail;

  if (!orderIndex) {
    orderIndex = {};

    var order = CF.CONFIG.HEADER_ORDER;

    for (var i = 0; i < order.length; i++) {
      orderIndex[
        order[i].toLowerCase()
      ] = i;
    }

    tail = order.length;
    CF.orderIndex = orderIndex;
    CF.orderTail = tail;
  } else {
    tail = CF.orderTail;
  }

  var keys = Object.keys(headers);
  var indexed = [];

  for (var j = 0; j < keys.length; j++) {
    var lower = keys[j].toLowerCase();

    indexed.push({
      key: keys[j],
      idx:
        lower in orderIndex
          ? orderIndex[lower]
          : tail,
      pos: j
    });
  }

  indexed.sort(function (a, b) {
    if (a.idx !== b.idx) {
      return a.idx - b.idx;
    }

    return a.pos - b.pos;
  });

  var result = {};

  for (var k = 0; k < indexed.length; k++) {
    result[indexed[k].key] =
      headers[indexed[k].key];
  }

  return result;
};

// ================= Challenge =================

CF.isChallenge = function (status) {
  return (
    CF.CONFIG.CHALLENGE_STATUS.indexOf(status) >= 0
  );
};

// ================= Shadowrocket Safari UA =================

CF.buildSafariUA = function () {
  var env =
    typeof $environment !== 'undefined'
      ? $environment
      : {};

  var version =
    env['system-version'] ||
    env.systemVersion ||
    env.osVersion ||
    env.version ||
    null;

  var usedFallback = false;

  if (!version) {
    version =
      CF.CONFIG.FALLBACK_UA_VERSION_DOTTED;
    usedFallback = true;
  }

  version = String(version);

  var underscored =
    version.replace(/\./g, '_');

  return {
    ua:
      'Mozilla/5.0 (iPhone; CPU iPhone OS ' +
      underscored +
      ' like Mac OS X) AppleWebKit/605.1.15 ' +
      '(KHTML, like Gecko) Version/' +
      version +
      ' Mobile/15E148 Safari/604.1',

    usedFallback: usedFallback
  };
};

// ================= 持久化存储 =================

CF.storeKey = function (domain) {
  return (
    CF.CONFIG.STORE_PREFIX +
    domain.replace(/\./g, '_')
  );
};

CF.saveCookie = function (domain, data) {
  try {
    return (
      $persistentStore.write(
        JSON.stringify(data),
        CF.storeKey(domain)
      ) === true
    );
  } catch (e) {
    return false;
  }
};

CF.loadCookie = function (domain) {
  try {
    var raw = $persistentStore.read(
      CF.storeKey(domain)
    );

    if (!raw) return null;

    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
};

CF.clearCookie = function (domain) {
  try {
    $persistentStore.write(
      '',
      CF.storeKey(domain)
    );
  } catch (e) {}

  try {
    $persistentStore.write(
      '',
      CF.visitKey(domain)
    );
  } catch (e) {}
};

// ================= Shadowrocket 通知 =================

CF.notify = function (
  subtitle,
  content,
  openUrl
) {
  try {
    if (openUrl) {
      try {
        $notification.post(
          CF.CONFIG.NOTIFY_TITLE,
          subtitle,
          content,
          {
            url: openUrl,
            'open-url': openUrl
          }
        );

        return;
      } catch (e) {}
    }

    $notification.post(
      CF.CONFIG.NOTIFY_TITLE,
      subtitle,
      content
    );
  } catch (e) {
    try {
      if (
        typeof $notify !== 'undefined'
      ) {
        $notify(
          CF.CONFIG.NOTIFY_TITLE,
          subtitle,
          content,
          openUrl
            ? {
                url: openUrl,
                'open-url': openUrl
              }
            : {}
        );
      }
    } catch (ignore) {}
  }
};

// ================= 请求头清理 =================

CF.buildCleanHeaders = function (
  request,
  overrides
) {
  var sourceHeaders =
    (request && request.headers) || {};

  overrides = overrides || {};

  var newHeaders = {};
  var whitelist =
    CF.CONFIG.HEADER_WHITELIST;
  var sourceKeys =
    Object.keys(sourceHeaders);

  // 只保留白名单 Header
  for (
    var i = 0;
    i < sourceKeys.length;
    i++
  ) {
    var key = sourceKeys[i];

    if (
      whitelist.indexOf(
        key.toLowerCase()
      ) >= 0
    ) {
      newHeaders[key] =
        sourceHeaders[key];
    }
  }

  // 注入 Cookie
  if (
    overrides.cookie !== undefined
  ) {
    CF.setHeaderCI(
      newHeaders,
      'Cookie',
      CF.scrubCookie(
        overrides.cookie
      )
    );
  }

  // 注入 UA
  if (overrides.ua !== undefined) {
    CF.setHeaderCI(
      newHeaders,
      'User-Agent',
      overrides.ua
    );
  }

  // 强制 Safari 导航 Header
  var navHeaders =
    CF.CONFIG.SAFARI_NAV_HEADERS;
  var navKeys =
    Object.keys(navHeaders);

  for (
    var j = 0;
    j < navKeys.length;
    j++
  ) {
    CF.setHeaderCI(
      newHeaders,
      navKeys[j],
      navHeaders[navKeys[j]]
    );
  }

  var targetHost =
    CF.hostFromUrl(request.url);

  var referer =
    CF.getHeaderCI(
      newHeaders,
      'Referer'
    );

  var origin =
    CF.getHeaderCI(
      newHeaders,
      'Origin'
    );

  CF.setHeaderCI(
    newHeaders,
    'Sec-Fetch-Site',
    CF.deriveSecFetchSite(
      referer,
      origin,
      targetHost
    )
  );

  // Safari strict-origin-when-cross-origin
  var sanitized =
    CF.sanitizeReferer(
      referer,
      request.url
    );

  if (!sanitized.send) {
    CF.removeHeaderCI(
      newHeaders,
      'Referer'
    );
  } else if (referer) {
    CF.setHeaderCI(
      newHeaders,
      'Referer',
      sanitized.value
    );
  }

  return CF.orderHeaders(newHeaders);
};

// ================= 请求阶段 =================

CF.handleRequest = function (domain) {
  var request = $request;
  var headers =
    (request && request.headers) || {};

  var cookieHeader =
    CF.getHeaderCI(
      headers,
      'Cookie'
    );

  var userAgent =
    CF.getHeaderCI(
      headers,
      'User-Agent'
    );

  var clearance =
    CF.extractClearance(
      cookieHeader
    );

  // Safari 已经携带 cf_clearance：
  // 学习并缓存真实浏览器身份
  if (clearance) {
    var previous =
      CF.loadCookie(domain);

    var changed =
      !previous ||
      previous.cf_clearance !== clearance ||
      (previous.cookies || '') !==
        (cookieHeader || '') ||
      (previous.ua || '') !==
        (userAgent || '');

    if (changed) {
      var saved = CF.saveCookie(
        domain,
        {
          cf_clearance: clearance,
          cookies: cookieHeader,
          ua: userAgent,
          savedAt: Date.now(),
          domain: domain
        }
      );

      if (
        !previous ||
        previous.cf_clearance !==
          clearance
      ) {
        CF.notify(
          '获取成功 ' + domain,
          '已捕获 cf_clearance'
        );
      }

      if (!saved) {
        CF.notify(
          domain + ' 存储失败',
          'cf_clearance 未能写入持久化存储'
        );
      }
    } else {
      previous.savedAt = Date.now();
      CF.saveCookie(
        domain,
        previous
      );
    }

    // Safari 原始请求直接放行
    $done({});
    return;
  }

  // 第三方 App 请求无 clearance
  var cached =
    CF.loadCookie(domain);

  if (
    !cached ||
    !cached.cf_clearance
  ) {
    var visitKey =
      CF.visitKey(domain);

    try {
      if (
        !$persistentStore.read(
          visitKey
        )
      ) {
        CF.notify(
          '首次访问 ' + domain,
          '无缓存 cf_clearance，请在 Safari 打开该站点完成验证'
        );

        $persistentStore.write(
          '1',
          visitKey
        );
      }
    } catch (e) {}

    $done({});
    return;
  }

  var fallbackUA = '';

  if (!cached.ua) {
    try {
      fallbackUA =
        CF.buildSafariUA().ua;
    } catch (e) {
      fallbackUA = '';
    }
  }

  var injectHeaders =
    CF.buildCleanHeaders(
      request,
      {
        cookie:
          cached.cookies ||
          (
            'cf_clearance=' +
            cached.cf_clearance
          ),

        ua:
          cached.ua ||
          userAgent ||
          fallbackUA
      }
    );

  $done({
    headers: injectHeaders
  });
};

// ================= 响应阶段 =================

CF.handleResponse = function (domain) {
  var response =
    typeof $response !== 'undefined'
      ? $response
      : null;

  var status =
    parseInt(
      response &&
        (
          response.statusCode ||
          response.status
        ),
      10
    ) || 0;

  if (CF.isChallenge(status)) {
    var cached =
      CF.loadCookie(domain);

    var now = Date.now();

    var fresh =
      cached &&
      cached.savedAt &&
      (
        now - cached.savedAt <=
        CF.CONFIG.PROTECT_WINDOW
      );

    if (!fresh) {
      CF.clearCookie(domain);
    }

    if (
      CF.notifyThrottled(domain)
    ) {
      var requestUrl =
        $request &&
        $request.url;

      var host =
        CF.hostFromUrl(
          requestUrl
        ) || domain;

      var openUrl =
        requestUrl ||
        (
          'https://' +
          host +
          '/'
        );

      CF.notify(
        'CF 盾失效 ' + host,
        '检测到 challenge，点击通知使用 Safari 重新验证',
        openUrl
      );
    }
  }

  $done({});
};

// ================= 入口 =================

CF.dispatch = function () {
  try {
    if (
      typeof $request ===
        'undefined' ||
      !$request ||
      !$request.url
    ) {
      $done({});
      return;
    }

    var host =
      CF.hostFromUrl(
        $request.url
      );

    if (!host) {
      $done({});
      return;
    }

    var domain =
      CF.registrableDomain(host);

    if (
      typeof $response ===
        'undefined' ||
      !$response
    ) {
      CF.handleRequest(domain);
    } else {
      CF.handleResponse(domain);
    }
  } catch (e) {
    CF.notify(
      '脚本异常',
      String(
        e &&
        e.message ||
        e
      )
    );

    $done({});
  }
};

// ================= 自测 =================

function CF_assert(condition, message) {
  if (!condition) {
    throw new Error(
      message ||
      'assertion failed'
    );
  }
}

CF.selfTest = function () {
  var results = [];

  function check(name, fn) {
    try {
      fn();

      results.push({
        name: name,
        ok: true
      });
    } catch (e) {
      results.push({
        name: name,
        ok: false,
        err: String(
          e &&
          e.message ||
          e
        )
      });
    }
  }

  check(
    'isChallenge 403',
    function () {
      CF_assert(
        CF.isChallenge(403)
      );
    }
  );

  check(
    'isChallenge 503',
    function () {
      CF_assert(
        CF.isChallenge(503)
      );
    }
  );

  check(
    'isChallenge 200',
    function () {
      CF_assert(
        !CF.isChallenge(200)
      );
    }
  );

  check(
    'extractClearance',
    function () {
      CF_assert(
        CF.extractClearance(
          'a=1; cf_clearance=TOK; b=2'
        ) === 'TOK'
      );
    }
  );

  check(
    'registrableDomain',
    function () {
      CF_assert(
        CF.registrableDomain(
          'www.example.com'
        ) === 'example.com'
      );
    }
  );

  check(
    'scrubCookie',
    function () {
      CF_assert(
        CF.scrubCookie(
          'a=1; _ym_isad=1; _ym_uid=x; b=2'
        ) === 'a=1; b=2'
      );
    }
  );

  return {
    passed: results.every(
      function (item) {
        return item.ok;
      }
    ),
    results: results
  };
};

// ================= 执行 =================

if (
  typeof $request !== 'undefined'
) {
  if (
    typeof $argument !==
      'undefined' &&
    $argument === '__test__'
  ) {
    var testResult =
      CF.selfTest();

    try {
      $notification.post(
        'CF 插件自测',
        testResult.passed
          ? '全部通过'
          : '存在失败',
        testResult.passed
          ? (
              testResult.results.length +
              ' 项全过'
            )
          : testResult.results
              .filter(function (item) {
                return !item.ok;
              })
              .map(function (item) {
                return item.name;
              })
              .join(', ')
      );
    } catch (e) {}

    $done({});
  } else {
    CF.dispatch();
  }
}

// Node.js 测试导出
if (
  typeof module !== 'undefined' &&
  module.exports
) {
  module.exports = CF;
}
