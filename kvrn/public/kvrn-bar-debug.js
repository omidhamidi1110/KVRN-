/* KVRN announcement-bar diagnostic recorder (CP72).
 *
 * INERT unless loaded. It is loaded only when the page URL contains ?barDebug=1 (the flag is then
 * remembered for the tab session; ?barDebug=0 turns it off). It never changes the bar, nav or any
 * layout: it only reads geometry, draws two non-interactive guide outlines, and shows a small
 * panel at the BOTTOM of the screen. Nothing is sent anywhere; "Copy JSON" copies to the clipboard.
 *
 * What it answers: after a refresh, does the BAR change size, does the TEXT move inside an
 * unchanged bar, or is the whole fixed bar being shifted by the browser's visual viewport / toolbar
 * / safe area (which getBoundingClientRect() alone does NOT show — compare barTopVsVisualViewport).
 */
(function () {
  'use strict'
  if (window.__kvrnBarDebug) return
  window.__kvrnBarDebug = true
  // Leave <head> exactly as the server rendered it, so this recorder cannot cause a hydration mismatch.
  try { var me = document.currentScript; if (me && me.parentNode) me.parentNode.removeChild(me) } catch (e) {}
  // No DOM WRITES (probe div, panel, guides) until React has finished hydrating; measuring only reads.
  var uiReady = false

  var KEY = 'kvrn-bar-debug-log'
  var MAX = 80
  var loadId = Math.random().toString(36).slice(2, 7)
  var log = []
  var t0 = performance.now()

  function store(get, set) {
    try { return get() } catch (e) { return set ? set() : null }
  }
  // Prior entries (from before the refresh) are kept so the pre- and post-refresh runs can be copied together.
  var prior = store(function () { return JSON.parse(sessionStorage.getItem(KEY) || '[]') }, function () { return [] }) || []
  function persist() {
    store(function () { sessionStorage.setItem(KEY, JSON.stringify(prior.concat(log).slice(-MAX))) })
  }

  function r(n) { return n == null ? null : Math.round(n * 100) / 100 }
  function rect(el) {
    if (!el) return null
    var b = el.getBoundingClientRect()
    return { top: r(b.top), bottom: r(b.bottom), left: r(b.left), height: r(b.height), width: r(b.width) }
  }
  function glyphRect(p) {
    // The painted text box (not the <p> box): shows where the glyphs actually sit.
    try {
      if (!p || !p.firstChild) return null
      var g = document.createRange()
      g.selectNodeContents(p)
      var b = g.getBoundingClientRect()
      return { top: r(b.top), bottom: r(b.bottom), height: r(b.height) }
    } catch (e) { return null }
  }
  var lastSafe = null
  function safeAreaTop() {
    if (!uiReady) return lastSafe
    // env(safe-area-inset-top) is only non-zero with viewport-fit=cover or standalone display.
    try {
      var d = document.createElement('div')
      d.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top,0px);height:0'
      document.body.appendChild(d)
      var v = parseFloat(getComputedStyle(d).paddingTop) || 0
      d.remove()
      lastSafe = v
      return v
    } catch (e) { return null }
  }
  function cs(el, props) {
    if (!el) return null
    var s = getComputedStyle(el), o = {}
    for (var i = 0; i < props.length; i++) o[props[i]] = s.getPropertyValue(props[i])
    return o
  }

  function snapshot(label) {
    var bar = document.getElementById('kvrn-announcement-bar')
    var p = bar && bar.querySelector('p')
    var nav = document.querySelector('header, nav')
    var vv = window.visualViewport
    var br = rect(bar), pr = rect(p), gr = glyphRect(p), nr = rect(nav)
    var snap = document.querySelector('[data-snap-page]')
    var navEntry = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null
    var s = {
      loadId: loadId, label: label, t: r(performance.now() - t0),
      navType: navEntry ? navEntry.type : null,
      scrollRestoration: history.scrollRestoration,
      readyState: document.readyState,
      hydrated: !!p, // <p> text exists once the client (or SSR) has rendered a message
      standalone: navigator.standalone === true || (window.matchMedia && matchMedia('(display-mode: standalone)').matches),
      win: { innerW: innerWidth, innerH: innerHeight, outerH: outerHeight, clientH: document.documentElement.clientHeight, scrollY: r(scrollY) },
      visualViewport: vv ? { w: r(vv.width), h: r(vv.height), offsetTop: r(vv.offsetTop), pageTop: r(vv.pageTop), scale: r(vv.scale) } : null,
      safeAreaTop: safeAreaTop(),
      overflow: { html: getComputedStyle(document.documentElement).overflowY, body: document.body ? getComputedStyle(document.body).overflowY : null, snapScrollTop: snap ? r(snap.scrollTop) : null },
      bar: br, text: pr, glyph: gr, nav: nr,
      // THE numbers: gap above/below the painted text inside the bar, and whether the bar itself moved.
      gapAboveText: br && gr ? r(gr.top - br.top) : null,
      gapBelowText: br && gr ? r(br.bottom - gr.bottom) : null,
      barTopVsVisualViewport: br && vv ? r(br.top - vv.offsetTop) : null,
      navTopMinusBarBottom: br && nr ? r(nr.top - br.bottom) : null,
      barStyle: cs(bar, ['position', 'top', 'height', 'padding-top', 'padding-bottom', 'transform', 'display', 'align-items', 'box-sizing']),
      textStyle: cs(p, ['font-family', 'font-size', 'line-height', 'transform', 'opacity', 'padding-top', 'margin-top', 'top']),
      cssVars: { bar: getComputedStyle(document.documentElement).getPropertyValue('--bar-height').trim(), nav: getComputedStyle(document.documentElement).getPropertyValue('--nav-height').trim() },
      fontsStatus: document.fonts ? document.fonts.status : null,
      ua: navigator.userAgent
    }
    log.push(s)
    persist()
    paint(s)
    return s
  }

  // ---- panel + guides (read-only, pointer-events none except the buttons) ----
  var panel, out, guideBar, guideGlyph
  function ui() {
    if (panel || !uiReady || !document.body) return
    var z = 'z-index:2147483647;position:fixed;'
    panel = document.createElement('div')
    panel.setAttribute('data-kvrn-bar-debug', '')
    panel.style.cssText = z + 'left:0;right:0;bottom:0;background:rgba(0,0,0,.88);color:#9f9;font:11px/1.35 ui-monospace,Menlo,monospace;padding:6px 8px;max-height:38vh;overflow:auto;-webkit-user-select:text;user-select:text'
    var btns = document.createElement('div')
    btns.style.cssText = 'display:flex;gap:6px;margin-bottom:4px;flex-wrap:wrap'
    function btn(txt, fn) {
      var b = document.createElement('button')
      b.textContent = txt
      b.style.cssText = 'background:#222;color:#fff;border:1px solid #666;border-radius:4px;padding:6px 10px;font:12px system-ui'
      b.addEventListener('click', fn)
      btns.appendChild(b)
    }
    btn('Mark: LOOKS WRONG', function () { snapshot('USER_MARK_LOOKS_WRONG') })
    btn('Mark: looks ok', function () { snapshot('USER_MARK_LOOKS_OK') })
    btn('Copy JSON', function () {
      var txt = JSON.stringify(prior.concat(log), null, 1)
      var done = function () { out.firstChild.textContent = 'COPIED ' + (prior.length + log.length) + ' entries\n' + out.firstChild.textContent }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { fallbackCopy(txt); done() })
      else { fallbackCopy(txt); done() }
    })
    btn('Clear', function () { prior = []; log = []; persist(); out.firstChild.textContent = 'cleared' })
    out = document.createElement('pre')
    out.style.cssText = 'margin:0;white-space:pre-wrap;word-break:break-all'
    out.appendChild(document.createTextNode(''))
    panel.appendChild(btns); panel.appendChild(out)
    guideBar = document.createElement('div')
    guideBar.style.cssText = z + 'pointer-events:none;outline:1px solid rgba(255,0,0,.9);outline-offset:-1px'
    guideGlyph = document.createElement('div')
    guideGlyph.style.cssText = z + 'pointer-events:none;outline:1px solid rgba(0,255,255,.95);outline-offset:0'
    document.body.appendChild(guideBar)
    document.body.appendChild(guideGlyph)
    document.body.appendChild(panel)
  }
  function fallbackCopy(txt) {
    try {
      var ta = document.createElement('textarea')
      ta.value = txt; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
      document.body.appendChild(ta); ta.focus(); ta.select()
      document.execCommand('copy'); ta.remove()
    } catch (e) {}
  }
  function place(el, b) {
    if (!b) { el.style.display = 'none'; return }
    el.style.display = 'block'
    el.style.top = b.top + 'px'; el.style.left = (b.left || 0) + 'px'
    el.style.width = (b.width || innerWidth) + 'px'; el.style.height = b.height + 'px'
  }
  function paint(s) {
    ui()
    if (!out) return
    var bar = document.getElementById('kvrn-announcement-bar')
    place(guideBar, rect(bar))
    var g = glyphRect(bar && bar.querySelector('p'))
    place(guideGlyph, g ? { top: g.top, left: (rect(bar.querySelector('p')) || {}).left, width: (rect(bar.querySelector('p')) || {}).width, height: g.height } : null)
    var l = s.label + ' t=' + s.t + ' nav=' + s.navType + ' hyd=' + s.hydrated +
      '\nbarH=' + (s.bar && s.bar.height) + ' barTop=' + (s.bar && s.bar.top) + ' aboveText=' + s.gapAboveText + ' belowText=' + s.gapBelowText +
      ' navGap=' + s.navTopMinusBarBottom +
      '\nvv.offTop=' + (s.visualViewport && s.visualViewport.offsetTop) + ' vv.h=' + (s.visualViewport && s.visualViewport.h) + ' innerH=' + s.win.innerH + ' safeTop=' + s.safeAreaTop +
      ' standalone=' + s.standalone + ' scrollY=' + s.win.scrollY + ' barVsVV=' + s.barTopVsVisualViewport
    out.firstChild.textContent = l + '\n----\n' + out.firstChild.textContent.slice(0, 600)
  }

  // ---- when to record ----
  snapshot('script-run(pre-body)')
  // The moment the SSR bar first exists in the DOM (before hydration / first paint where possible).
  var seen = false
  var mo = new MutationObserver(function () {
    if (!seen && document.getElementById('kvrn-announcement-bar')) {
      seen = true
      snapshot('bar-first-in-DOM(SSR)')
      requestAnimationFrame(function () { snapshot('first-rAF-after-bar') })
      mo.disconnect()
    }
  })
  mo.observe(document.documentElement, { childList: true, subtree: true })
  document.addEventListener('DOMContentLoaded', function () { snapshot('DOMContentLoaded') })
  window.addEventListener('load', function () {
    snapshot('load')
    setTimeout(function () { uiReady = true; snapshot('ui-ready(after hydration)') }, 1800)
    var delays = [150, 500, 1200, 2500, 5000]
    delays.forEach(function (d) { setTimeout(function () { snapshot('load+' + d + 'ms') }, d) })
  })
  window.addEventListener('pageshow', function (e) { snapshot('pageshow persisted=' + e.persisted) })
  window.addEventListener('pagehide', function () { snapshot('pagehide') })
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { snapshot('fonts.ready') })
  var rt
  function soon(label) { clearTimeout(rt); rt = setTimeout(function () { snapshot(label) }, 120) }
  window.addEventListener('resize', function () { soon('resize') })
  window.addEventListener('orientationchange', function () { soon('orientationchange') })
  window.addEventListener('scroll', function () { soon('scroll') }, { passive: true })
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', function () { soon('vv.resize') })
    visualViewport.addEventListener('scroll', function () { soon('vv.scroll') })
  }
  document.addEventListener('visibilitychange', function () { snapshot('visibility=' + document.visibilityState) })

  // Layout-shift entries (which node moved, from where to where).
  try {
    new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (e) {
        var src = (e.sources || []).map(function (x) {
          var n = x.node
          return { node: n ? (n.id ? '#' + n.id : n.tagName) : null, prev: x.previousRect && { top: r(x.previousRect.top), h: r(x.previousRect.height) }, cur: x.currentRect && { top: r(x.currentRect.top), h: r(x.currentRect.height) } }
        })
        log.push({ loadId: loadId, label: 'layout-shift', t: r(e.startTime), value: r(e.value), sources: src })
        persist()
      })
    }).observe({ type: 'layout-shift', buffered: true })
  } catch (e) { /* not supported (Safari): the geometry snapshots still cover it */ }
})()
