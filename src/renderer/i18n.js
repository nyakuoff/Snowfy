window.I18n = (function () {
  let _locale = 'en';
  let _translations = {};
  let _fallback = {};
  const _listeners = [];

  const SUPPORTED = ['en','es','pt','fr','de','ja','ko','zh','it','tr','ru','hi'];

  function resolveLocale(locale) {
    const lang = locale.split('-')[0].toLowerCase();
    return SUPPORTED.includes(lang) ? lang : 'en';
  }

  async function init(locale) {
    _locale = resolveLocale(locale);
    const override = localStorage.getItem('snowify_locale');
    if (override) _locale = override;

    const base = '../locales/';
    const [trans, fb] = await Promise.all([
      fetch(base + _locale + '.json').then(r => r.json()),
      _locale !== 'en'
        ? fetch(base + 'en.json').then(r => r.json())
        : Promise.resolve({})
    ]);
    _translations = trans;
    _fallback = fb;
    translatePage();
  }

  function t(key, params) {
    let str = _translations[key] || _fallback[key] || key;
    if (params) {
      for (const [k, v] of Object.entries(params))
        str = str.replaceAll('{{' + k + '}}', v);
    }
    return str;
  }

  function tp(key, count, params) {
    const rule = new Intl.PluralRules(_locale).select(count);
    let str = _translations[key + '.' + rule]
           || _translations[key + '.other']
           || _fallback[key + '.' + rule]
           || _fallback[key + '.other']
           || key;
    if (params || count !== undefined) {
      const all = { count, ...params };
      for (const [k, v] of Object.entries(all))
        str = str.replaceAll('{{' + k + '}}', v);
    }
    return str;
  }

  function translatePage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = t(el.dataset.i18n);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = t(el.dataset.i18nTitle);
    });
    document.querySelectorAll('[data-i18n-aria]').forEach(el => {
      el.setAttribute('aria-label', t(el.dataset.i18nAria));
    });
    _listeners.forEach(fn => fn(_locale));
  }

  function onChange(fn) { _listeners.push(fn); }

  async function changeLanguage(locale) {
    localStorage.setItem('snowify_locale', locale);
    await init(locale);
  }

  function getLocale() { return _locale; }

  return { init, t, tp, translatePage, changeLanguage, onChange, getLocale };
})();
