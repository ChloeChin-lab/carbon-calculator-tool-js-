(function () {
  "use strict";

  var DB = RULEBOOK;          /* reference tables + materials library */
  var userMixes = [];         /* custom mixes saved in this browser   */

  var state = {
    projectRows: null,        /* output of ENGINE.calculateProjectRows */
    projectTotals: null,
    durProjectName: null,
    durAlloc: null,           /* allocated carbon per component/material */
    durGridRows: null,        /* the editable grid                       */
    durMechanism: "CHLORIDE",
    durExposure: "XS1",
    durDetail: null,
    durMaterial: null,
    durSummary: null,
    cmpMode: "mix"
  };

  /* =================================================================
   * tiny DOM helpers
   * ================================================================= */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text !== undefined) { e.textContent = text; }
    return e;
  }
  function clear(node) { while (node.firstChild) { node.removeChild(node.firstChild); } }

  function toast(msg) {
    var t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }

  /** Format a number for display. Mirrors _numfmt() in the Python engine. */
  function fmt(v, nd) {
    if (nd === undefined) { nd = 2; }
    if (typeof v === "string") { return v; }
    if (v === null || v === undefined) { return "not given"; }
    var n = Number(v);
    if (isNaN(n)) { return "not given"; }
    if (!isFinite(n)) { return "no limit"; }
    return n.toLocaleString(undefined, { minimumFractionDigits: nd, maximumFractionDigits: nd });
  }

  /** Build a <table> from an array of row objects. */
  function renderTable(tableEl, rows, opts) {
    opts = opts || {};
    clear(tableEl);
    if (!rows || !rows.length) {
      var tr0 = el("tr");
      var td0 = el("td", null, opts.empty || "Nothing to show yet.");
      td0.colSpan = 1; tr0.appendChild(td0); tableEl.appendChild(tr0);
      return;
    }
    var cols = opts.columns || Object.keys(rows[0]).filter(function (c) {
      return c.charAt(0) !== "_";
    });

    var thead = el("thead"), htr = el("tr");
    cols.forEach(function (c) {
      var th = el("th", null, c);
      if (typeof rows[0][c] === "number") { th.className = "num"; }
      var help = DB.column_descriptions && DB.column_descriptions[c];
      if (help) { th.title = help; th.textContent = c + " ⓘ"; }
      htr.appendChild(th);
    });
    thead.appendChild(htr); tableEl.appendChild(thead);

    var tbody = el("tbody");
    rows.forEach(function (r) {
      var tr = el("tr");
      cols.forEach(function (c) {
        var v = r[c];
        var td = el("td");
        if (typeof v === "number") {
          td.className = "num";
          td.textContent = fmt(v, (opts.precise || []).indexOf(c) !== -1 ? 4 : 2);
        } else {
          td.textContent = (v === null || v === undefined) ? "" : String(v);
        }
        if (c === "Durability check") { td.className = (v === "PASS") ? "pass" : "fail"; }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tableEl.appendChild(tbody);
  }

  function toCsv(rows, cols) {
    cols = cols || Object.keys(rows[0] || {});
    var lines = [cols.map(csvCell).join(",")];
    rows.forEach(function (r) {
      lines.push(cols.map(function (c) { return csvCell(r[c]); }).join(","));
    });
    return lines.join("\n");
  }
  function csvCell(v) {
    if (v === null || v === undefined) { return ""; }
    var s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = el("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function allMaterialNames() {
    var names = [];
    (DB.mixes || []).forEach(function (m) { names.push(m.Mix_Key); });
    (DB.direct || []).forEach(function (d) { names.push(d.Material_Key); });
    names.sort();
    userMixes.forEach(function (m) { names.push("Custom: " + m.mix_name); });
    return names;
  }

  /* =================================================================
   * TABS
   * ================================================================= */
  function initTabs() {
    var buttons = document.querySelectorAll(".tab");
    Array.prototype.forEach.call(buttons, function (b) {
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(buttons, function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        Array.prototype.forEach.call(document.querySelectorAll(".panel"), function (p) {
          p.classList.remove("active");
        });
        $("tab-" + b.dataset.tab).classList.add("active");
        if (b.dataset.tab === "durability")  { refreshDurabilityProjects(); }
        if (b.dataset.tab === "comparison")  { refreshComparisonPickers(); }
        if (b.dataset.tab === "library")     { refreshLibrary(); }
      });
    });
  }
  function goToTab(name) {
    var b = document.querySelector('.tab[data-tab="' + name + '"]');
    if (b) { b.click(); }
  }

  /* =================================================================
   * TAB 1 — MATERIALS & MIXES
   * ================================================================= */
  function initMaterialsTab() {
    var sel = $("matSelect");
    function fill() {
      clear(sel);
      allMaterialNames().forEach(function (n) {
        sel.appendChild(new Option(n, n));
      });
      showBreakdown();
    }

    function showBreakdown() {
      var name = sel.value;
      var box = $("matBreakdown");
      clear(box);
      if (!name) { return; }
      var props = ENGINE.calcMixCarbon(name, DB, userMixes);
      var mix = ENGINE.findRow(DB.mixes, "Mix_Key", name);
      var g = ENGINE.parseGrade(name);

      var lines = [
        ["Density", fmt(props["Mass (kg/m3)"], 1) + " kg/m³"],
        ["GWP100 factor", fmt(props["Factor_GWP (kgCO2e/kg)"], 4) + " kgCO₂e per kg"],
        ["Carbon per cubic metre",
         fmt(props["Mass (kg/m3)"] * props["Factor_GWP (kgCO2e/kg)"], 1) + " kgCO₂e/m³"]
      ];
      if (g[0] !== null) {
        var s = ENGINE.getStrength(name, DB);
        lines.push(["Recognised grade", s.Grade + "  (f_ck,cyl = " + s.fck_cyl + " MPa)"]);
        var b = ENGINE.autofillBinder(name, DB, userMixes);
        lines.push(["Binder content", fmt(b.cement + b.additive, 0) + " kg/m³ (" +
                    fmt(b.cement, 0) + " cement + " + fmt(b.additive, 0) + " additive)"]);
        lines.push(["k400 (carbonation)",
                    fmt(ENGINE.defaultCarbonationCoefficient(s.Grade, s.fck_cyl, s.fcm_cyl, DB), 2) +
                    " mm/year^0.5"]);
        lines.push(["Dc (chloride)",
                    fmt(ENGINE.defaultDiffusionCoefficient(s.Grade, s.fck_cyl, DB), 2) +
                    " ×10⁻⁶ mm²/s"]);
      }
      var tbl = el("table");
      lines.forEach(function (l) {
        var tr = el("tr");
        tr.appendChild(el("td", null, l[0]));
        var td = el("td", "num", l[1]);
        tr.appendChild(td);
        tbl.appendChild(tr);
      });
      box.appendChild(tbl);

      if (mix) {
        box.appendChild(el("h4", null, "Ingredients (kg per m³)"));
        var it = el("table");
        (DB.factors || []).forEach(function (f) {
          var v = mix[f.Component];
          if (v === undefined || v === null || v === "" || ENGINE.sf(v) === 0) { return; }
          var tr = el("tr");
          tr.appendChild(el("td", null, f.Component));
          tr.appendChild(el("td", "num", fmt(ENGINE.sf(v), 1)));
          tr.appendChild(el("td", "num",
            fmt(ENGINE.sf(v) * ENGINE.sf(f.ECFGWP100_kgCO2e_kg), 2) + " kgCO₂e"));
          it.appendChild(tr);
        });
        box.appendChild(it);
      }
    }

    sel.addEventListener("change", showBreakdown);

    /* ---- custom mix builder ---- */
    var ing = $("mixIngredients");
    clear(ing);
    (DB.factors || []).forEach(function (f) {
      var lab = el("label", null, f.Component + " (kg/m³)");
      var inp = el("input");
      inp.type = "number"; inp.step = "0.1"; inp.value = "0";
      inp.dataset.component = f.Component;
      lab.appendChild(inp);
      ing.appendChild(lab);
    });

    function readCustomMix() {
      var comps = {};
      Array.prototype.forEach.call(ing.querySelectorAll("input"), function (i) {
        var v = ENGINE.sf(i.value);
        if (v !== 0) { comps[i.dataset.component] = v; }
      });
      return comps;
    }

    $("btnCalcMix").addEventListener("click", function () {
      var comps = readCustomMix();
      var tmp = [{ mix_name: "__preview__", components: comps, adhoc_materials: [] }];
      var p = ENGINE.calcMixCarbon("Custom: __preview__", DB, tmp);
      var box = $("mixResult");
      clear(box);
      box.appendChild(el("div", null,
        "Density: " + fmt(p["Mass (kg/m3)"], 1) + " kg/m³"));
      box.appendChild(el("div", null,
        "GWP100: " + fmt(p["Factor_GWP (kgCO2e/kg)"], 4) + " kgCO₂e/kg  →  " +
        fmt(p["Mass (kg/m3)"] * p["Factor_GWP (kgCO2e/kg)"], 1) + " kgCO₂e per m³"));
      box.appendChild(el("div", null,
        "Embodied energy: " +
        fmt(p["Mass (kg/m3)"] * p["Factor_EE (MJ/kg)"] / 1000, 3) + " GJ per m³"));
    });

    $("btnSaveMix").addEventListener("click", function () {
      var name = $("mixName").value.trim();
      if (!name) { toast("Give the mix a name first."); return; }
      var mix = { mix_name: name, components: readCustomMix(), adhoc_materials: [] };
      STORE.saveMix(mix).then(function () {
        return STORE.listMixes();
      }).then(function (ms) {
        userMixes = ms;
        fill();
        renderSavedMixes();
        toast("Mix '" + name + "' saved in this browser.");
      });
    });

    function renderSavedMixes() {
      var box = $("savedMixList");
      clear(box);
      if (!userMixes.length) { box.appendChild(el("span", "hint", "None yet.")); return; }
      userMixes.forEach(function (m) {
        var lab = el("label");
        lab.appendChild(el("span", null, m.mix_name));
        var x = el("button", "btn ghost", "×");
        x.addEventListener("click", function () {
          STORE.deleteMix(m.mix_name).then(function () { return STORE.listMixes(); })
            .then(function (ms) { userMixes = ms; fill(); renderSavedMixes(); });
        });
        lab.appendChild(x);
        box.appendChild(lab);
      });
    }

    initMaterialsTab.refresh = function () { fill(); renderSavedMixes(); };
    fill(); renderSavedMixes();
  }

  /* =================================================================
   * TAB 2 — PROJECT BUILDER
   * ================================================================= */
  var ROW_LABELS = {
    Concrete:   "Concrete",
    Rebars:     "Reinforcement bars",
    Strands:    "Prestressing strands",
    Steel:      "Structural steel",
    Bracing:    "Bracing",
    Bolts_Nuts: "Bolts & nuts"
  };

  function initProjectTab() {
    var sel = $("structSelect");
    clear(sel);
    (DB.structures || []).forEach(function (s) {
      sel.appendChild(new Option(s.Structure, s.Structure));
    });

    $("btnBuildForm").addEventListener("click", buildComponentForms);
    $("btnCalcProject").addEventListener("click", calculateProject);
    $("btnSaveProject").addEventListener("click", saveProject);
    $("btnClearProject").addEventListener("click", function () {
      clear($("componentForms")); clear($("projectResults"));
      $("projectActions").style.display = "none";
      $("projName").value = "";
    });
  }

  function buildComponentForms(preset) {
    var structName = $("structSelect").value;
    var struct = null;
    (DB.structures || []).forEach(function (s) { if (s.Structure === structName) { struct = s; } });
    if (!struct) { return; }

    var host = $("componentForms");
    clear(host);
    var mats = allMaterialNames();

    struct.Components.forEach(function (comp) {
      var card = el("div", "card");
      card.dataset.component = comp.name;
      card.appendChild(el("h3", null, comp.name));

      if (comp.rows.indexOf("extra") !== -1) {
        card.appendChild(el("p", "hint",
          "One line per item:  Item name, Material key, Quantity, Unit"));
        var ta = el("textarea");
        ta.dataset.field = "extra_materials";
        ta.placeholder = "Bearings, Steel, 2.5, tonnes\nSurfacing, Asphalt, 180, m3";
        card.appendChild(ta);
        host.appendChild(card);
        return;
      }

      if (comp.units) {
        var urow = el("div", "row");
        var ulab = el("label", null, "Number of units");
        var uinp = el("input");
        uinp.type = "number"; uinp.min = "1"; uinp.value = "1";
        uinp.dataset.field = "number_of_units";
        ulab.appendChild(uinp); urow.appendChild(ulab);
        card.appendChild(urow);
      }

      comp.rows.forEach(function (key) {
        var row = el("div", "row");

        var lab1 = el("label", "grow", ROW_LABELS[key] || key);
        if (key === "Concrete") {
          var msel = el("select");
          msel.dataset.field = "Concrete_mat";
          msel.appendChild(new Option("--- Select ---", ""));
          mats.forEach(function (m) { msel.appendChild(new Option(m, m)); });
          lab1.appendChild(msel);
        } else {
          var fixed = el("input");
          fixed.type = "text"; fixed.value = "Steel"; fixed.readOnly = true;
          lab1.appendChild(fixed);
        }
        row.appendChild(lab1);

        var lab2 = el("label", null, "Quantity");
        var qin = el("input");
        qin.type = "number"; qin.step = "0.001"; qin.value = "0";
        qin.dataset.field = key + "_vol";
        lab2.appendChild(qin); row.appendChild(lab2);

        var lab3 = el("label", null, "Unit");
        var usel = el("select");
        usel.dataset.field = key + "_unit";
        (DB.unit_options || []).forEach(function (u) { usel.appendChild(new Option(u, u)); });
        usel.value = (key === "Concrete") ? "m3 / unit"
                   : (key === "Steel")    ? "tonnes / unit" : "% of vol.";
        lab3.appendChild(usel); row.appendChild(lab3);

        card.appendChild(row);
      });

      host.appendChild(card);
    });

    $("projectActions").style.display = "flex";
    if (preset) { applyPreset(preset); }
  }

  /** Read every component card back into the ui_data shape the engine expects. */
  function collectProjectData() {
    var components = {};
    Array.prototype.forEach.call($("componentForms").children, function (card) {
      var name = card.dataset.component;
      if (!name) { return; }
      var data = {};
      Array.prototype.forEach.call(card.querySelectorAll("[data-field]"), function (f) {
        data[f.dataset.field] = f.value;
      });
      components[name] = data;
    });
    return { structure: $("structSelect").value, components: components };
  }

  function applyPreset(uiData) {
    if (uiData.structure) { $("structSelect").value = uiData.structure; }
    Array.prototype.forEach.call($("componentForms").children, function (card) {
      var cd = (uiData.components || {})[card.dataset.component];
      if (!cd) { return; }
      Array.prototype.forEach.call(card.querySelectorAll("[data-field]"), function (f) {
        if (cd[f.dataset.field] !== undefined) { f.value = cd[f.dataset.field]; }
      });
    });
  }

  function calculateProject() {
    var uiData = collectProjectData();
    var res = ENGINE.calculateProjectRows(DB, userMixes, uiData);
    state.projectRows = res.rows;
    state.projectTotals = res.totals;

    var host = $("projectResults");
    clear(host);

    if (res.errors.length) {
      var warn = el("div", "callout err");
      warn.appendChild(el("strong", null, "Warnings"));
      res.errors.forEach(function (e) { warn.appendChild(el("div", null, "• " + e)); });
      host.appendChild(warn);
    }
    if (!res.rows.length) {
      host.appendChild(el("div", "callout",
        "No quantities were entered, so there is nothing to total."));
      return;
    }

    var card = el("div", "card");
    card.appendChild(el("h3", null, "Project totals"));

    var sum = el("div", "summary");
    [["Total mass", fmt(res.totals.Total_Mass_kg / 1000, 2) + " t"],
     ["Embodied energy", fmt(res.totals.Total_EE_GJ, 1) + " GJ"],
     ["Embodied carbon (EC)", fmt(res.totals.Total_EC_kgCO2 / 1000, 2) + " tCO₂"],
     ["Global warming potential (GWP100)", fmt(res.totals.Total_GWP100_kgCO2e / 1000, 3) + " tCO₂e"]
    ].forEach(function (m) {
      var d = el("div", "metric");
      d.appendChild(el("div", "metric-label", m[0]));
      d.appendChild(el("div", "metric-value", m[1]));
      sum.appendChild(d);
    });
    card.appendChild(sum);

    var rows = res.rows.map(function (r) {
      return {
        "Item": r.item_name, "Material": r.material,
        "Quantity": r.volume_input, "Unit": r.unit,
        "Total Mass (kg)": r.mass_kg,
        "Total EE (GJ)": r.ee_gj,
        "Total EC (kgCO2)": r.ec_kgco2,
        "Total GWP100 (kgCO2e)": r.gwp_kgco2e
      };
    });
    var scroll = el("div", "table-scroll");
    var tbl = el("table");
    renderTable(tbl, rows);
    scroll.appendChild(tbl);
    card.appendChild(scroll);

    var btn = el("button", "btn ghost", "Download line items as CSV");
    btn.addEventListener("click", function () {
      download(($("projName").value || "project") + "_lineitems.csv", toCsv(rows), "text/csv");
    });
    var brow = el("div", "row"); brow.appendChild(btn);
    card.appendChild(brow);

    host.appendChild(card);
    toast("Calculated " + res.rows.length + " line items.");
  }

  function saveProject() {
    var name = $("projName").value.trim();
    if (!name) { toast("Give the project a name first."); return; }
    var uiData = collectProjectData();
    STORE.saveProject(name, uiData).then(function () {
      toast("Project '" + name + "' saved in this browser.");
      refreshDurabilityProjects();
    });
  }

  /* =================================================================
   * TAB 3 — DURABILITY & SERVICE LIFE
   * ================================================================= */
  function initDurabilityTab() {
    var exp = $("durExposure");
    clear(exp);
    (DB.exposure_classes || []).forEach(function (e) {
      exp.appendChild(new Option(e.Class + ". " + e.Description, e.Class));
    });
    exp.value = "XS1";

    var loc = $("durLocation");
    clear(loc);
    (DB.location_k1 || []).forEach(function (l) {
      loc.appendChild(new Option(l.Location_Type, l.Location_Type));
    });
    loc.addEventListener("change", function () {
      var hit = null;
      (DB.location_k1 || []).forEach(function (l) {
        if (l.Location_Type === loc.value) { hit = l; }
      });
      if (hit) { $("durK1").value = ENGINE.sf(hit.k1_default, 1.0).toFixed(2); }
    });

    exp.addEventListener("change", onExposureChanged);
    $("durDistance").addEventListener("input", updateSurfaceChloride);
    $("durC1").addEventListener("input", updateSurfaceChloride);

    $("btnLoadMaterials").addEventListener("click", loadProjectMaterials);
    $("btnBuildGrid").addEventListener("click", buildGrid);
    $("btnRunAssessment").addEventListener("click", runAssessment);
    $("btnSaveRun").addEventListener("click", saveRun);
    $("btnExportDur").addEventListener("click", function () {
      if (!state.durDetail) { toast("Run an assessment first."); return; }
      download((state.durProjectName || "assessment") + "_durability.csv",
               toCsv(state.durDetail), "text/csv");
    });

    onExposureChanged();
  }

  function onExposureChanged() {
    var cls = $("durExposure").value;
    var mech = "NONE";
    (DB.exposure_classes || []).forEach(function (e) {
      if (e.Class === cls) { mech = e.Mechanism; }
    });
    state.durExposure = cls;
    state.durMechanism = mech;
    $("durMechanism").textContent =
      mech === "CARBONATION" ? "Carbonation" : (mech === "CHLORIDE" ? "Chloride" : "Not modelled");
    $("carbInputs").style.display = (mech === "CARBONATION") ? "flex" : "none";
    $("chlInputs").style.display  = (mech === "CHLORIDE")    ? "flex" : "none";
    if (mech === "CHLORIDE") { updateSurfaceChloride(); }
  }

  function updateSurfaceChloride() {
    var d = ENGINE.sf($("durDistance").value, 0.001);
    var c1 = ENGINE.sf($("durC1").value, 0.6);
    var cs = ENGINE.surfaceChlorideFromDistance(d, c1);
    $("durSurface").value = cs.toFixed(3);
    $("chlHint").textContent =
      "Airborne salt = c₁ × d^(−0.6); surface = 1.5 × (airborne)^0.4. Collapsed, that is " +
      ENGINE.collapsedConstant(c1).toFixed(5) + " × d^(−0.24), giving 6.417 kg/m³ at one metre " +
      "and 0.704 kg/m³ at ten kilometres.";
  }

  function refreshDurabilityProjects() {
    return STORE.listProjects().then(function (ps) {
      var sel = $("durProject");
      var prev = sel.value;
      clear(sel);
      ps.forEach(function (p) { sel.appendChild(new Option(p.project_name, p.project_name)); });
      if (prev) { sel.value = prev; }
      return ps;
    });
  }

  function loadProjectMaterials() {
    var name = $("durProject").value;
    if (!name) { toast("Save a project first, in the Project Builder tab."); return; }
    STORE.loadProject(name).then(function (uiData) {
      if (!uiData) { toast("Could not load that project."); return; }
      var res = ENGINE.calculateProjectRows(DB, userMixes, uiData);
      state.durProjectName = name;
      state.durProjectRows = res.rows;

      var cm = ENGINE.groupComponentMaterials(res.rows, DB, userMixes);
      state.durComponentMaterials = cm;

      var host = $("durMaterials");
      clear(host);
      var scroll = el("div", "table-scroll");
      var tbl = el("table");
      renderTable(tbl, cm.map(function (r) {
        return {
          "Component": r.Component, "Material": r.Material,
          "Volume (m3)": r["Volume (m3)"], "Mass (kg)": r["Mass (kg)"],
          "Embodied carbon (tonne CO2e)": r["Embodied carbon (tonne CO2e)"]
        };
      }));
      scroll.appendChild(tbl);
      host.appendChild(scroll);

      /* which of these materials are the concretes? */
      var pick = $("durConcretePick");
      clear(pick);
      pick.appendChild(el("h4", null,
        "Which of these are the concretes? Everything else is charged to them as supporting carbon."));
      var list = el("div", "chip-list");
      var seen = {};
      cm.forEach(function (r) {
        if (seen[r.Material]) { return; }
        seen[r.Material] = true;
        var lab = el("label");
        var cb = el("input");
        cb.type = "checkbox"; cb.value = r.Material;
        cb.checked = r["Is Concrete"];
        lab.appendChild(cb);
        lab.appendChild(el("span", null, r.Material));
        list.appendChild(lab);
      });
      pick.appendChild(list);

      toast("Loaded " + cm.length + " component/material lines from '" + name + "'.");
      refreshRunList();
    });
  }

  function chosenConcretes() {
    var out = [];
    Array.prototype.forEach.call(
      $("durConcretePick").querySelectorAll("input[type=checkbox]"), function (cb) {
        if (cb.checked) { out.push(cb.value); }
      });
    return out;
  }

  function buildGrid() {
    if (!state.durComponentMaterials) { toast("Load a project's materials first."); return; }
    var concretes = chosenConcretes();
    if (!concretes.length) { toast("Tick at least one concrete."); return; }

    var alloc = ENGINE.allocateComponentCarbon(state.durComponentMaterials, concretes);
    state.durAlloc = alloc;

    var rows = ENGINE.buildInputTable(
      alloc, state.durMechanism, state.durExposure, DB, userMixes,
      ENGINE.sf($("durLife").value, 100), ENGINE.sf($("durAllowance").value, 10),
      $("durQC").checked);

    ENGINE.refreshDerived(rows, state.durExposure,
      ENGINE.sf($("durAllowance").value, 10), $("durQC").checked, DB);

    state.durGridRows = rows;
    drawGrid();
    toast("Grid built for " + rows.length + " concrete lines.");
  }

  function drawGrid() {
    var table = $("durGrid");
    clear(table);
    var rows = state.durGridRows;
    if (!rows || !rows.length) { return; }
    var cols = ENGINE.expectedColumns(state.durMechanism);
    var C = ENGINE.COL;

    var thead = el("thead"), htr = el("tr");
    cols.forEach(function (c) {
      var th = el("th");
      var help = DB.column_descriptions && DB.column_descriptions[c];
      th.textContent = help ? c + " ⓘ" : c;
      if (help) { th.title = help; }
      htr.appendChild(th);
    });
    thead.appendChild(htr); table.appendChild(thead);

    var tbody = el("tbody");
    rows.forEach(function (r, ri) {
      var tr = el("tr");
      cols.forEach(function (c) {
        var td = el("td");
        var readOnly = (c === C.COMPONENT || c === C.MATERIAL ||
                        ENGINE.CALCULATED_COLUMNS.indexOf(c) !== -1);
        if (readOnly) {
          td.className = (c === C.COMPONENT || c === C.MATERIAL) ? "" : "calc";
          td.textContent = (typeof r[c] === "number") ? fmt(r[c], 1) : String(r[c] === null ? "" : r[c]);
        } else if (c === C.ELEMENT || c === C.CLASS) {
          var sel = el("select");
          var opts = (c === C.ELEMENT)
            ? ["Reinforced", "Prestressed"]
            : ["Automatic", "S1", "S2", "S3", "S4", "S5", "S6", "Not applicable"];
          opts.forEach(function (o) { sel.appendChild(new Option(o, o)); });
          sel.value = r[c];
          sel.addEventListener("change", function () {
            rows[ri][c] = sel.value;
            ENGINE.refreshDerived(rows, state.durExposure,
              ENGINE.sf($("durAllowance").value, 10), $("durQC").checked, DB);
            drawGrid();
          });
          td.appendChild(sel);
        } else {
          var inp = el("input");
          inp.type = "number"; inp.step = "any";
          inp.value = (r[c] === null || r[c] === undefined) ? "" : r[c];
          inp.addEventListener("change", function () {
            rows[ri][c] = inp.value === "" ? null : ENGINE.sf(inp.value);
          });
          td.appendChild(inp);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  function runAssessment() {
    if (!state.durGridRows || !state.durGridRows.length) {
      toast("Build the input grid first."); return;
    }
    ENGINE.refreshDerived(state.durGridRows, state.durExposure,
      ENGINE.sf($("durAllowance").value, 10), $("durQC").checked, DB);

    var detail;
    if (state.durMechanism === "CARBONATION") {
      detail = ENGINE.runCarbonation(state.durGridRows, state.durAlloc,
        ENGINE.sf($("durK1").value, 1.0), ENGINE.sf($("durK2").value, 1.4));
    } else {
      detail = ENGINE.runChloride(state.durGridRows, state.durAlloc,
        ENGINE.sf($("durSurface").value, 0));
    }
    var mat = ENGINE.materialSummary(detail);
    var sum = ENGINE.structureSummary(mat);

    state.durDetail = detail;
    state.durMaterial = mat;
    state.durSummary = sum;

    var host = $("durSummary");
    clear(host);
    [
      ["Materials checked", sum.n_materials + " (" + sum.n_pass + " pass)", sum.all_pass ? "good" : "bad"],
      ["Governing design life", fmt(sum.governing_life, 0) + " years", ""],
      ["Total embodied carbon", fmt(sum.total_carbon, 2) + " tCO₂e", ""],
      ["Volume-weighted f_ck", fmt(sum.weighted_fck, 1) + " MPa", ""],
      ["Whole-structure efficiency index", fmt(sum.structure_index, 3), ""],
      ["Sum of material indices", fmt(sum.sum_index, 3), ""]
    ].forEach(function (m) {
      var d = el("div", "metric " + m[2]);
      d.appendChild(el("div", "metric-label", m[0]));
      d.appendChild(el("div", "metric-value", m[1]));
      host.appendChild(d);
    });
    host.appendChild(el("p", "hint",
      "The efficiency index is in " + ENGINE.INDEX_UNITS + ". Higher is better."));

    var precise = ["Site carbonation coefficient", "Reference carbonation coefficient",
                   "Error function value", "Inverse error function value",
                   "Threshold concentration (kg per m3)", "Surface concentration (kg per m3)",
                   "Chloride diffusion coefficient", "Carbon efficiency index",
                   "Concrete carbon (tonne CO2e)", "Supporting carbon (tonne CO2e)",
                   "Total embodied carbon (tonne CO2e)"];
    renderTable($("durDetail"), detail, { precise: precise });
    renderTable($("durMaterialTable"), mat, { precise: precise });
    toast(sum.all_pass ? "All materials PASS." : "Some materials FAIL — see the table.");
  }

  function saveRun() {
    if (!state.durDetail) { toast("Run an assessment first."); return; }
    var vname = $("durVersionName").value.trim() ||
      (state.durExposure + ", " + fmt(ENGINE.sf($("durLife").value, 100), 0) + " years");
    var runData = {
      materials: state.durComponentMaterials,
      detail: state.durDetail,
      material_summary: state.durMaterial,
      summary: state.durSummary,
      inputs: state.durGridRows,
      settings: {
        design_life: ENGINE.sf($("durLife").value, 100),
        cover_allowance: ENGINE.sf($("durAllowance").value, 10),
        special_quality_control: $("durQC").checked,
        k1: ENGINE.sf($("durK1").value, 1.0),
        k2: ENGINE.sf($("durK2").value, 1.4),
        surface_chloride: ENGINE.sf($("durSurface").value, 0),
        distance_km: ENGINE.sf($("durDistance").value, 0.001),
        concretes: chosenConcretes()
      }
    };
    STORE.saveRun(state.durProjectName, vname, state.durMechanism,
                  state.durExposure, runData).then(function () {
      toast("Assessment '" + vname + "' saved.");
      refreshRunList();
    });
  }

  function refreshRunList() {
    if (!state.durProjectName) { return Promise.resolve(); }
    return STORE.listRuns(state.durProjectName).then(function (runs) {
      var host = $("durRunList");
      clear(host);
      if (!runs.length) { host.appendChild(el("p", "hint", "None yet.")); return; }
      var scroll = el("div", "table-scroll");
      var tbl = el("table");
      var thead = el("thead"), htr = el("tr");
      ["Version", "Mechanism", "Exposure", "Saved", ""].forEach(function (h) {
        htr.appendChild(el("th", null, h));
      });
      thead.appendChild(htr); tbl.appendChild(thead);
      var tbody = el("tbody");
      runs.forEach(function (r) {
        var tr = el("tr");
        tr.appendChild(el("td", null, r.version_name));
        tr.appendChild(el("td", null, r.mechanism));
        tr.appendChild(el("td", null, r.exposure_class || ""));
        tr.appendChild(el("td", null, String(r.created_at).slice(0, 16).replace("T", " ")));
        var td = el("td");
        var open = el("button", "btn", "Open");
        open.addEventListener("click", function () { loadRun(r.run_id); });
        var del = el("button", "btn ghost danger", "Delete");
        del.addEventListener("click", function () {
          STORE.deleteRun(r.run_id).then(refreshRunList);
        });
        td.appendChild(open); td.appendChild(del);
        tr.appendChild(td);
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody); scroll.appendChild(tbl); host.appendChild(scroll);
    });
  }

  function loadRun(runId) {
    STORE.getRun(runId).then(function (run) {
      if (!run) { return; }
      var s = run.run_data.settings || {};
      $("durExposure").value = run.exposure_class;
      onExposureChanged();
      $("durLife").value = s.design_life !== undefined ? s.design_life : 100;
      $("durAllowance").value = s.cover_allowance !== undefined ? s.cover_allowance : 10;
      $("durQC").checked = !!s.special_quality_control;
      if (s.k1 !== undefined) { $("durK1").value = s.k1; }
      if (s.k2 !== undefined) { $("durK2").value = s.k2; }
      if (s.distance_km !== undefined) { $("durDistance").value = s.distance_km; }
      if (s.surface_chloride !== undefined) { $("durSurface").value = s.surface_chloride; }

      state.durComponentMaterials = run.run_data.materials;
      state.durAlloc = ENGINE.allocateComponentCarbon(
        run.run_data.materials, s.concretes || []);
      state.durGridRows = run.run_data.inputs;
      state.durProjectName = run.project_name;
      drawGrid();
      runAssessment();
      toast("Restored version '" + run.version_name + "'.");
    });
  }

  /* =================================================================
   * TAB 4 — COMPARISON & ANALYSIS
   * ================================================================= */
  function initComparisonTab() {
    Array.prototype.forEach.call(document.querySelectorAll("[data-cmp]"), function (b) {
      b.addEventListener("click", function () {
        Array.prototype.forEach.call(document.querySelectorAll("[data-cmp]"), function (x) {
          x.classList.remove("active");
        });
        b.classList.add("active");
        state.cmpMode = b.dataset.cmp;
        $("cmpMixPane").style.display     = (state.cmpMode === "mix") ? "block" : "none";
        $("cmpProjectPane").style.display = (state.cmpMode === "project") ? "block" : "none";
      });
    });
    $("btnCmpMix").addEventListener("click", compareMixes);
    $("btnCmpProject").addEventListener("click", compareProjects);
  }

  function refreshComparisonPickers() {
    var box = $("cmpMixPick");
    clear(box);
    allMaterialNames().forEach(function (n) {
      var lab = el("label");
      var cb = el("input"); cb.type = "checkbox"; cb.value = n;
      lab.appendChild(cb); lab.appendChild(el("span", null, n));
      box.appendChild(lab);
    });
    return STORE.listProjects().then(function (ps) {
      var pbox = $("cmpProjPick");
      clear(pbox);
      if (!ps.length) { pbox.appendChild(el("span", "hint", "No saved projects yet.")); return; }
      ps.forEach(function (p) {
        var lab = el("label");
        var cb = el("input"); cb.type = "checkbox"; cb.value = p.project_name;
        lab.appendChild(cb); lab.appendChild(el("span", null, p.project_name));
        pbox.appendChild(lab);
      });
    });
  }

  function checkedValues(container) {
    var out = [];
    Array.prototype.forEach.call(container.querySelectorAll("input[type=checkbox]"),
      function (cb) { if (cb.checked) { out.push(cb.value); } });
    return out;
  }

  function drawBars(host, rows, labelKey, valueKey, unit, altKey) {
    var max = 0;
    rows.forEach(function (r) {
      max = Math.max(max, ENGINE.sf(r[valueKey]), altKey ? ENGINE.sf(r[altKey]) : 0);
    });
    if (max <= 0) { return; }
    rows.forEach(function (r) {
      var row = el("div", "bar-row");
      row.appendChild(el("div", "bar-label", String(r[labelKey])));
      var track = el("div", "bar-track");
      var fill = el("div", "bar-fill");
      fill.style.width = (100 * ENGINE.sf(r[valueKey]) / max) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el("div", "bar-value", fmt(r[valueKey], 1) + " " + unit));
      host.appendChild(row);
    });
  }

  function compareMixes() {
    var names = checkedValues($("cmpMixPick"));
    var host = $("cmpMixOut");
    clear(host);
    if (names.length < 2) { toast("Tick at least two materials."); return; }

    var rows = names.map(function (n) {
      var p = ENGINE.calcMixCarbon(n, DB, userMixes);
      var s = ENGINE.getStrength(n, DB);
      var carbonPerM3 = p["Mass (kg/m3)"] * p["Factor_GWP (kgCO2e/kg)"];
      var out = {
        "Material": n,
        "Density (kg/m3)": p["Mass (kg/m3)"],
        "GWP100 (kgCO2e/m3)": carbonPerM3,
        "Embodied energy (GJ/m3)": p["Mass (kg/m3)"] * p["Factor_EE (MJ/kg)"] / 1000,
        "f_ck (MPa)": s.fck_cyl
      };
      out["Strength per tonne CO2e (MPa/t)"] =
        carbonPerM3 > 0 ? s.fck_cyl / (carbonPerM3 / 1000.0) : NaN;
      return out;
    });

    rows.sort(function (a, b) { return a["GWP100 (kgCO2e/m3)"] - b["GWP100 (kgCO2e/m3)"]; });
    var best = rows[0], worst = rows[rows.length - 1];
    var saving = worst["GWP100 (kgCO2e/m3)"] - best["GWP100 (kgCO2e/m3)"];
    var pct = worst["GWP100 (kgCO2e/m3)"] > 0
      ? 100 * saving / worst["GWP100 (kgCO2e/m3)"] : 0;

    var call = el("div", "callout");
    call.appendChild(el("strong", null, "Executive summary"));
    call.appendChild(el("div", null,
      "Lowest carbon per cubic metre: " + best.Material + " at " +
      fmt(best["GWP100 (kgCO2e/m3)"], 1) + " kgCO₂e/m³."));
    call.appendChild(el("div", null,
      "Highest: " + worst.Material + " at " + fmt(worst["GWP100 (kgCO2e/m3)"], 1) +
      " kgCO₂e/m³ — a difference of " + fmt(saving, 1) + " kgCO₂e/m³ (" + fmt(pct, 1) + "%)."));
    call.appendChild(el("div", null,
      "Note that carbon per cubic metre alone does not decide the better mix. " +
      "A denser mix may carry more load and last longer, which is what the " +
      "carbon efficiency index in the Durability tab is for."));
    host.appendChild(call);

    host.appendChild(el("h4", null, "Embodied carbon per cubic metre"));
    drawBars(host, rows, "Material", "GWP100 (kgCO2e/m3)", "kgCO₂e/m³");

    var scroll = el("div", "table-scroll");
    var tbl = el("table"); renderTable(tbl, rows);
    scroll.appendChild(tbl); host.appendChild(scroll);

    var b = el("button", "btn ghost", "Download comparison as CSV");
    b.addEventListener("click", function () {
      download("material_comparison.csv", toCsv(rows), "text/csv");
    });
    var r = el("div", "row"); r.appendChild(b); host.appendChild(r);
  }

  function compareProjects() {
    var names = checkedValues($("cmpProjPick"));
    var host = $("cmpProjOut");
    clear(host);
    if (names.length < 2) { toast("Tick at least two projects."); return; }

    Promise.all(names.map(function (n) {
      return STORE.loadProject(n).then(function (d) {
        var res = ENGINE.calculateProjectRows(DB, userMixes, d || {});
        return {
          "Project": n,
          "Structure": (d && d.structure) || "",
          "Total mass (t)": res.totals.Total_Mass_kg / 1000,
          "Embodied energy (GJ)": res.totals.Total_EE_GJ,
          "Embodied carbon (tCO2)": res.totals.Total_EC_kgCO2 / 1000,
          "GWP100 (tCO2e)": res.totals.Total_GWP100_kgCO2e / 1000
        };
      });
    })).then(function (rows) {
      rows.sort(function (a, b) { return a["GWP100 (tCO2e)"] - b["GWP100 (tCO2e)"]; });
      var best = rows[0], worst = rows[rows.length - 1];
      var saving = worst["GWP100 (tCO2e)"] - best["GWP100 (tCO2e)"];
      var pct = worst["GWP100 (tCO2e)"] > 0 ? 100 * saving / worst["GWP100 (tCO2e)"] : 0;

      var call = el("div", "callout");
      call.appendChild(el("strong", null, "Executive summary"));
      call.appendChild(el("div", null,
        "Lowest total GWP100: " + best.Project + " at " + fmt(best["GWP100 (tCO2e)"], 3) + " tCO₂e."));
      call.appendChild(el("div", null,
        "Highest: " + worst.Project + " at " + fmt(worst["GWP100 (tCO2e)"], 3) +
        " tCO₂e. Choosing the better design avoids " + fmt(saving, 3) +
        " tCO₂e, or " + fmt(pct, 1) + "%."));
      host.appendChild(call);

      host.appendChild(el("h4", null, "Total embodied carbon (GWP100)"));
      drawBars(host, rows, "Project", "GWP100 (tCO2e)", "tCO₂e");

      var scroll = el("div", "table-scroll");
      var tbl = el("table"); renderTable(tbl, rows);
      scroll.appendChild(tbl); host.appendChild(scroll);

      var b = el("button", "btn ghost", "Download comparison as CSV");
      b.addEventListener("click", function () {
        download("project_comparison.csv", toCsv(rows), "text/csv");
      });
      var r = el("div", "row"); r.appendChild(b); host.appendChild(r);
    });
  }

  /* =================================================================
   * TAB 5 — MY LIBRARY
   * ================================================================= */
  function initLibraryTab() {
    $("btnRefreshLibrary").addEventListener("click", refreshLibrary);
    $("btnExportAll").addEventListener("click", function () {
      STORE.exportAll().then(function (payload) {
        download("sustainability_backup_" +
                 new Date().toISOString().slice(0, 10) + ".json",
                 JSON.stringify(payload, null, 2), "application/json");
        toast("Backup downloaded.");
      });
    });
    $("fileImport").addEventListener("change", function (ev) {
      var f = ev.target.files[0];
      if (!f) { return; }
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var payload = JSON.parse(reader.result);
          STORE.importAll(payload, false).then(function () {
            toast("Backup restored."); refreshLibrary(); refreshDurabilityProjects();
          }).catch(function (e) { toast(e.message); });
        } catch (e) { toast("That file is not valid JSON."); }
      };
      reader.readAsText(f);
      ev.target.value = "";
    });
    $("btnClearAll").addEventListener("click", function () {
      if (!window.confirm("This erases every project and assessment stored in this browser. " +
                          "Download a backup first if you need one. Continue?")) { return; }
      STORE.clearAll().then(function () {
        userMixes = [];
        toast("Everything erased.");
        refreshLibrary(); refreshDurabilityProjects();
        if (initMaterialsTab.refresh) { initMaterialsTab.refresh(); }
      });
    });
  }

  function refreshLibrary() {
    return Promise.all([STORE.listProjects(), STORE.listRuns(null)])
      .then(function (r) {
        var projects = r[0], runs = r[1];

        var pt = $("libProjects");
        clear(pt);
        var thead = el("thead"), htr = el("tr");
        ["Project", "Structure", "Total mass (t)", "Total GWP100 (tCO2e)",
         "Saved assessments", "Actions"].forEach(function (h) {
          htr.appendChild(el("th", null, h));
        });
        thead.appendChild(htr); pt.appendChild(thead);

        var tbody = el("tbody");
        if (!projects.length) {
          var tr = el("tr"); var td = el("td", null, "No saved projects yet.");
          td.colSpan = 6; tr.appendChild(td); tbody.appendChild(tr);
        }
        projects.forEach(function (p) {
          var res = ENGINE.calculateProjectRows(DB, userMixes, p.project_data || {});
          var nRuns = runs.filter(function (x) { return x.project_name === p.project_name; }).length;
          var tr = el("tr");
          tr.appendChild(el("td", null, p.project_name));
          tr.appendChild(el("td", null, (p.project_data && p.project_data.structure) || ""));
          tr.appendChild(el("td", "num", fmt(res.totals.Total_Mass_kg / 1000, 2)));
          tr.appendChild(el("td", "num", fmt(res.totals.Total_GWP100_kgCO2e / 1000, 3)));
          tr.appendChild(el("td", "num", String(nRuns)));

          var td = el("td");
          var open = el("button", "btn", "Open");
          open.title = "Open in Project Builder";
          open.addEventListener("click", function () {
            goToTab("project");
            $("projName").value = p.project_name;
            $("structSelect").value = (p.project_data && p.project_data.structure) || "";
            buildComponentForms(p.project_data);
          });
          var assess = el("button", "btn", "Assess");
          assess.title = "Open in Durability & Service Life";
          assess.addEventListener("click", function () {
            goToTab("durability");
            refreshDurabilityProjects().then(function () {
              $("durProject").value = p.project_name;
              loadProjectMaterials();
            });
          });
          var del = el("button", "btn ghost danger", "Delete");
          del.addEventListener("click", function () {
            if (!window.confirm("Delete '" + p.project_name + "' and its assessments?")) { return; }
            STORE.deleteProject(p.project_name).then(function () {
              refreshLibrary(); refreshDurabilityProjects();
            });
          });
          td.appendChild(open); td.appendChild(assess); td.appendChild(del);
          tr.appendChild(td);
          tbody.appendChild(tr);
        });
        pt.appendChild(tbody);

        var rt = $("libRuns");
        clear(rt);
        var rhead = el("thead"), rhtr = el("tr");
        ["Project", "Version", "Mechanism", "Exposure", "Saved", "Result", "Open"]
          .forEach(function (h) { rhtr.appendChild(el("th", null, h)); });
        rhead.appendChild(rhtr); rt.appendChild(rhead);

        var rbody = el("tbody");
        if (!runs.length) {
          var tr2 = el("tr"); var td2 = el("td", null, "No saved assessments yet.");
          td2.colSpan = 7; tr2.appendChild(td2); rbody.appendChild(tr2);
        }
        runs.forEach(function (run) {
          var tr = el("tr");
          tr.appendChild(el("td", null, run.project_name));
          tr.appendChild(el("td", null, run.version_name));
          tr.appendChild(el("td", null, run.mechanism));
          tr.appendChild(el("td", null, run.exposure_class || ""));
          tr.appendChild(el("td", null, String(run.created_at).slice(0, 16).replace("T", " ")));
          var s = (run.run_data && run.run_data.summary) || {};
          var res = el("td", s.all_pass ? "pass" : "fail",
                       s.all_pass === undefined ? "" : (s.all_pass ? "PASS" : "FAIL"));
          tr.appendChild(res);
          var td = el("td");
          var b = el("button", "btn", "Open in Durability");
          b.addEventListener("click", function () {
            goToTab("durability");
            refreshDurabilityProjects().then(function () {
              $("durProject").value = run.project_name;
              loadRun(run.run_id);
            });
          });
          td.appendChild(b); tr.appendChild(td);
          rbody.appendChild(tr);
        });
        rt.appendChild(rbody);
      });
  }

  /* =================================================================
   * BOOT
   * ================================================================= */
  function boot() {
    initTabs();
    STORE.open().then(function () {
      $("chipStorage").textContent = "storage: " + STORE.backend();
      $("chipRulebook").textContent = "rulebook: " + DB._source;
      return STORE.listMixes();
    }).then(function (ms) {
      userMixes = ms || [];
      initMaterialsTab();
      initProjectTab();
      initDurabilityTab();
      initComparisonTab();
      initLibraryTab();
      return refreshDurabilityProjects();
    }).then(function () {
      return refreshLibrary();
    }).catch(function (e) {
      console.error(e);
      toast("Startup problem: " + e.message);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else { boot(); }
})();
// ============================================================
// FORCE FIX: Override all white text set by JavaScript
// ============================================================
(function fixWhiteText() {
    // Find every element on the page
    var allElements = document.querySelectorAll('*');
    for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        // If the element has an inline style that sets color to white, change it to dark
        if (el.style && el.style.color) {
            var color = el.style.color.toLowerCase();
            if (color === 'white' || color === '#fff' || color === '#ffffff' || color === 'rgb(255, 255, 255)') {
                el.style.color = '#16232e'; // Change to dark
            }
        }
    }
})();
