/* =====================================================================
 * storage.js  —  Option C (Static Browser App)
 * ---------------------------------------------------------------------
 * Option A keeps projects in Supabase (a Postgres server).
 * Option B keeps them in a local SQLite file.
 * Option C keeps them in IndexedDB, the database that is already built
 * into every browser. Nothing leaves the machine, and there is nothing
 * to install.
 *
 * Two object stores, matching the SQLite schema in app_desktop.py:
 *     projects  { project_name (key), project_data, updated_at }
 *     runs      { run_id (auto), project_name, version_name, mechanism,
 *                 exposure_class, created_at, run_data }
 *     mixes     { mix_name (key), components, adhoc_materials }
 *
 * If IndexedDB is blocked (private mode on some browsers, or a locked
 * corporate profile) the whole thing silently falls back to localStorage,
 * so the app never dies on the client's laptop during a demo.
 * ===================================================================== */

var STORE = (function () {
  "use strict";

  var DB_NAME = "sustainability_assessment_option_c";
  var DB_VERSION = 1;
  var db = null;
  var useFallback = false;
  var LS_KEY = "sas_option_c_fallback";

  /* ---------------- localStorage fallback ---------------- */
  function lsRead() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); }
    catch (e) { return {}; }
  }
  function lsWrite(o) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(o)); return true; }
    catch (e) { return false; }
  }
  function lsBucket(name) {
    var all = lsRead();
    if (!all[name]) { all[name] = {}; lsWrite(all); }
    return all[name];
  }

  /* ---------------- open ---------------- */
  function open() {
    return new Promise(function (resolve) {
      if (!window.indexedDB) { useFallback = true; return resolve("localStorage"); }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { useFallback = true; return resolve("localStorage"); }

      req.onupgradeneeded = function (ev) {
        var d = ev.target.result;
        if (!d.objectStoreNames.contains("projects")) {
          d.createObjectStore("projects", { keyPath: "project_name" });
        }
        if (!d.objectStoreNames.contains("runs")) {
          var rs = d.createObjectStore("runs", { keyPath: "run_id", autoIncrement: true });
          rs.createIndex("by_project", "project_name", { unique: false });
        }
        if (!d.objectStoreNames.contains("mixes")) {
          d.createObjectStore("mixes", { keyPath: "mix_name" });
        }
      };
      req.onsuccess = function (ev) { db = ev.target.result; resolve("IndexedDB"); };
      req.onerror = function () { useFallback = true; resolve("localStorage"); };
      /* if the browser never answers (rare, but it happens in locked-down
         profiles) fall back rather than hang the whole page */
      setTimeout(function () {
        if (!db && !useFallback) { useFallback = true; resolve("localStorage"); }
      }, 3000);
    });
  }

  function tx(storeName, mode) {
    return db.transaction([storeName], mode).objectStore(storeName);
  }

  function wrap(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  /* ---------------- projects ---------------- */

  function saveProject(name, data) {
    var record = { project_name: name, project_data: data,
                   updated_at: new Date().toISOString() };
    if (useFallback) {
      var all = lsRead();
      all.projects = all.projects || {};
      all.projects[name] = record;
      lsWrite(all);
      return Promise.resolve(record);
    }
    return wrap(tx("projects", "readwrite").put(record));
  }

  function loadProject(name) {
    if (useFallback) {
      var b = lsBucket("projects");
      return Promise.resolve(b[name] ? b[name].project_data : null);
    }
    return wrap(tx("projects", "readonly").get(name)).then(function (r) {
      return r ? r.project_data : null;
    });
  }

  function listProjects() {
    if (useFallback) {
      var b = lsBucket("projects"), out = [];
      for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) { out.push(b[k]); } }
      out.sort(function (a, c) { return a.project_name < c.project_name ? -1 : 1; });
      return Promise.resolve(out);
    }
    return wrap(tx("projects", "readonly").getAll()).then(function (rs) {
      rs.sort(function (a, c) { return a.project_name < c.project_name ? -1 : 1; });
      return rs;
    });
  }

  function deleteProject(name) {
    if (useFallback) {
      var all = lsRead();
      if (all.projects) { delete all.projects[name]; }
      if (all.runs) {
        for (var id in all.runs) {
          if (all.runs[id] && all.runs[id].project_name === name) { delete all.runs[id]; }
        }
      }
      lsWrite(all);
      return Promise.resolve(true);
    }
    return wrap(tx("projects", "readwrite").delete(name)).then(function () {
      return listRuns(name);
    }).then(function (runs) {
      return Promise.all(runs.map(function (r) { return deleteRun(r.run_id); }));
    });
  }

  /* ---------------- service-life runs (versioned assessments) ---------------- */

  function saveRun(projectName, versionName, mechanism, exposureClass, runData) {
    var record = {
      project_name: projectName, version_name: versionName,
      mechanism: mechanism, exposure_class: exposureClass,
      created_at: new Date().toISOString(), run_data: runData
    };
    if (useFallback) {
      var all = lsRead();
      all.runs = all.runs || {};
      all._next_run_id = (all._next_run_id || 0) + 1;
      record.run_id = all._next_run_id;
      all.runs[record.run_id] = record;
      lsWrite(all);
      return Promise.resolve(record);
    }
    return wrap(tx("runs", "readwrite").add(record));
  }

  function listRuns(projectName) {
    if (useFallback) {
      var b = lsBucket("runs"), out = [];
      for (var k in b) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) { continue; }
        if (!projectName || b[k].project_name === projectName) { out.push(b[k]); }
      }
      out.sort(function (a, c) { return c.created_at.localeCompare(a.created_at); });
      return Promise.resolve(out);
    }
    return wrap(tx("runs", "readonly").getAll()).then(function (rs) {
      var out = projectName
        ? rs.filter(function (r) { return r.project_name === projectName; })
        : rs;
      out.sort(function (a, c) { return c.created_at.localeCompare(a.created_at); });
      return out;
    });
  }

  function getRun(runId) {
    if (useFallback) { return Promise.resolve(lsBucket("runs")[runId] || null); }
    return wrap(tx("runs", "readonly").get(Number(runId)));
  }

  function deleteRun(runId) {
    if (useFallback) {
      var all = lsRead();
      if (all.runs) { delete all.runs[runId]; }
      lsWrite(all);
      return Promise.resolve(true);
    }
    return wrap(tx("runs", "readwrite").delete(Number(runId)));
  }

  /* ---------------- custom mixes ---------------- */

  function saveMix(mix) {
    if (useFallback) {
      var all = lsRead();
      all.mixes = all.mixes || {};
      all.mixes[mix.mix_name] = mix;
      lsWrite(all);
      return Promise.resolve(mix);
    }
    return wrap(tx("mixes", "readwrite").put(mix));
  }

  function listMixes() {
    if (useFallback) {
      var b = lsBucket("mixes"), out = [];
      for (var k in b) { if (Object.prototype.hasOwnProperty.call(b, k)) { out.push(b[k]); } }
      return Promise.resolve(out);
    }
    return wrap(tx("mixes", "readonly").getAll());
  }

  function deleteMix(name) {
    if (useFallback) {
      var all = lsRead();
      if (all.mixes) { delete all.mixes[name]; }
      lsWrite(all);
      return Promise.resolve(true);
    }
    return wrap(tx("mixes", "readwrite").delete(name));
  }

  /* ---------------- whole-database backup / restore ---------------- */

  function exportAll() {
    return Promise.all([listProjects(), listRuns(null), listMixes()])
      .then(function (r) {
        return {
          format: "sustainability-assessment-option-c",
          version: 1,
          exported_at: new Date().toISOString(),
          projects: r[0], runs: r[1], mixes: r[2]
        };
      });
  }

  function importAll(payload, replace) {
    if (!payload || payload.format !== "sustainability-assessment-option-c") {
      return Promise.reject(new Error("This file is not an Option C backup."));
    }
    var chain = Promise.resolve();
    if (replace) {
      chain = chain.then(function () { return clearAll(); });
    }
    chain = chain.then(function () {
      var ps = (payload.projects || []).map(function (p) {
        return saveProject(p.project_name, p.project_data);
      });
      return Promise.all(ps);
    }).then(function () {
      var rs = (payload.runs || []).map(function (r) {
        return saveRun(r.project_name, r.version_name, r.mechanism,
                       r.exposure_class, r.run_data);
      });
      return Promise.all(rs);
    }).then(function () {
      return Promise.all((payload.mixes || []).map(saveMix));
    });
    return chain;
  }

  function clearAll() {
    if (useFallback) { lsWrite({}); return Promise.resolve(true); }
    return Promise.all([
      wrap(tx("projects", "readwrite").clear()),
      wrap(tx("runs", "readwrite").clear()),
      wrap(tx("mixes", "readwrite").clear())
    ]);
  }

  function backend() { return useFallback ? "Browser localStorage" : "Browser IndexedDB"; }

  return {
    open: open, backend: backend,
    saveProject: saveProject, loadProject: loadProject,
    listProjects: listProjects, deleteProject: deleteProject,
    saveRun: saveRun, listRuns: listRuns, getRun: getRun, deleteRun: deleteRun,
    saveMix: saveMix, listMixes: listMixes, deleteMix: deleteMix,
    exportAll: exportAll, importAll: importAll, clearAll: clearAll
  };
})();
