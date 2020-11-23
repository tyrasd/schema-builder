/* eslint-disable no-console */
/* Downloads the latest translations from Transifex */
const fs = require('fs');
const fetch = require('node-fetch');
const btoa = require('btoa');
const YAML = require('js-yaml');


function fetchTranslations(options) {

  let defaultCredentials = {
    user: 'api',
    password: ''
  };
  if (fs.existsSync(`${process.cwd()}/transifex.auth`)) {
    // Credentials can be stored in transifex.auth as a json object. You should probably gitignore this file.
    // You can use an API key instead of your password: https://docs.transifex.com/api/introduction#authentication
    // {
    //   "user": "username",
    //   "password": "password"
    // }
    defaultCredentials = JSON.parse(fs.readFileSync(`${process.cwd()}/transifex.auth`, 'utf8'));
  }

  options = Object.assign({
    credentials: defaultCredentials,
    outDirectory: 'dist',
    organizationId: '',
    projectId: '',
    resourceIds: ['presets'],
    reviewedOnly: false,
    sourceLocale: 'en'
  }, options);

  const outDir = `./${options.outDirectory}/translations`;

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir);
  }

  const fetchOpts = {
    headers: {
      'Authorization': 'Basic ' + btoa(options.credentials.user + ':' + options.credentials.password),
    }
  };

  const apiroot = 'https://www.transifex.com/api/2';
  const projectURL = `${apiroot}/project/${options.projectId}`;

  const resourceIds = options.resourceIds;
  asyncMap(resourceIds, getResourceInfo, function(err, results) {
    gotResourceInfo(err, results);
    asyncMap(resourceIds, getResource, gotResource);
  });

  function getResourceInfo(resourceId, callback) {
    let url = `https://api.transifex.com/organizations/${options.organizationId}/projects/${options.projectId}/resources/${resourceId}`;
    fetch(url, fetchOpts)
      .then(res => {
        console.log(`${res.status}: ${url}`);
        return res.json();
      })
      .then(json => {
        callback(null, json);
      })
      .catch(err => callback(err));
  }

  function gotResourceInfo(err, results) {
    if (err) return console.log(err);

    let coverageByLocaleCode = {};
    results.forEach(function(info) {
      for (let code in info.stats) {
        let type = 'translated';
        if (options.reviewedOnly &&
          (!Array.isArray(options.reviewedOnly) || options.reviewedOnly.indexOf(code) !== -1)) {
          // reviewed_1 = reviewed, reviewed_2 = proofread
          type = 'reviewed_1';
        }
        let coveragePart = info.stats[code][type].percentage / results.length;

        code = code.replace(/_/g, '-');
        if (coverageByLocaleCode[code] === undefined) coverageByLocaleCode[code] = 0;
        coverageByLocaleCode[code] += coveragePart;
      }
    });
    let dataLocales = {};
    // explicitly list the source locale as having 100% coverage
    dataLocales[options.sourceLocale] = { pct: 1 };

    for (let code in coverageByLocaleCode) {
      let coverage = coverageByLocaleCode[code];
      // we don't need high precision here, but we need to know if it's exactly 100% or not
      coverage = Math.floor(coverage * 100) / 100;
      dataLocales[code] = {
        pct: coverage
      };
    }

    const keys = Object.keys(dataLocales).sort();
    let sortedLocales = {};
    keys.forEach(k => sortedLocales[k] = dataLocales[k]);
    fs.writeFileSync(`${outDir}/index.json`, JSON.stringify(sortedLocales));
  }

  function getResource(resourceId, callback) {
    let resourceURL = `${projectURL}/resource/${resourceId}`;
    getLanguages(resourceURL, (err, codes) => {
      if (err) return callback(err);

      asyncMap(codes, getLanguage(resourceURL), (err, results) => {
        if (err) return callback(err);

        let locale = {};
        results.forEach((result, i) => {
          // remove preset terms that were not really translated
          let presets = (result.presets && result.presets.presets) || {};
          for (const key of Object.keys(presets)) {
            let preset = presets[key];
            if (!preset.terms) continue;
            preset.terms = preset.terms.replace(/<.*>/, '').trim();
            if (!preset.terms) {
              delete preset.terms;
              if (!Object.keys(preset).length) {
                delete presets[key];
              }
            }
          }
          // remove field terms that were not really translated
          let fields = (result.presets && result.presets.fields) || {};
          for (const key of Object.keys(fields)) {
            let field = fields[key];
            if (!field.terms) continue;
            field.terms = field.terms.replace(/\[.*\]/, '').trim();
            if (!field.terms) {
              delete field.terms;
              if (!Object.keys(field).length) {
                delete fields[key];
              }
            }
          }

          locale[codes[i]] = result;
        });

        callback(null, locale);
      });
    });
  }


  function gotResource(err, results) {
    if (err) return console.log(err);

    // merge in strings fetched from transifex
    let allStrings = {};
    results.forEach(resourceStrings => {
      Object.keys(resourceStrings).forEach(code => {
        if (!allStrings[code]) allStrings[code] = {};
        let source = resourceStrings[code];
        let target = allStrings[code];
        Object.keys(source).forEach(k => target[k] = source[k]);
      });
    });

    for (let code in allStrings) {
      let obj = {};
      obj[code] = allStrings[code] || {};
      fs.writeFileSync(`${outDir}/${code}.json`, JSON.stringify(obj));
    }
  }


  function getLanguage(resourceURL) {
    return (code, callback) => {
      code = code.replace(/-/g, '_');
      let url = `${resourceURL}/translation/${code}`;
      if (options.reviewedOnly &&
        (!Array.isArray(options.reviewedOnly) || options.reviewedOnly.indexOf(code) !== -1)) {

        url += '?mode=reviewed';
      }
      fetch(url, fetchOpts)
        .then(res => {
          console.log(`${res.status}: ${url}`);
          return res.json();
        })
        .then(json => {
          callback(null, YAML.safeLoad(json.content)[code]);
        })
        .catch(err => callback(err));
    };
  }


  function getLanguages(resourceURL, callback) {
    let url = `${resourceURL}?details`;
    fetch(url, fetchOpts)
      .then(res => {
        console.log(`${res.status}: ${url}`);
        return res.json();
      })
      .then(json => {
        callback(null, json.available_languages
          .map(d => d.code.replace(/_/g, '-'))
          // we already have the source locale so don't download it
          .filter(d => d !== options.sourceLocale)
        );
      })
      .catch(err => callback(err));
  }
}


function asyncMap(inputs, func, callback) {
  let index = 0;
  let remaining = inputs.length;
  let results = [];
  let error;

  next();

  function next() {
    callFunc(index++);
    if (index < inputs.length) {
      setTimeout(next, 200);
    }
  }

  function callFunc(i) {
    let d = inputs[i];
    func(d, (err, data) => {
      if (err) error = err;
      results[i] = data;
      remaining--;
      if (!remaining && callback) callback(error, results);
    });
  }
}

module.exports.fetchTranslations = fetchTranslations;