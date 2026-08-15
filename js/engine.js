/* =====================================================================
 * engine.js  —  Option C (Static Browser App)
 * ---------------------------------------------------------------------
 * A direct port of the two Python engines used by Options A and B:
 *
 *   project_engine.py       -> quantity take-off + embodied carbon totals
 *   service_life_engine.py  -> carbonation, chloride, structural class,
 *                              minimum cover, carbon allocation, and the
 *                              carbon efficiency index
 *
 * Nothing here touches the DOM and nothing here touches storage, so the
 * same file can be unit-tested in Node or reused in a future mobile build.
 * Function names mirror the Python ones so the three codebases can be
 * diffed side by side during review.
 * ===================================================================== */

var ENGINE = (function () {
  "use strict";

  var SECONDS_PER_YEAR = 365.25 * 24 * 3600.0;

  /* Airborne chloride model constants (service_life_engine.py lines 33-36) */
  var CS_C1_DEFAULT = 0.6;   /* calibration constant of the airborne salt law */
  var CS_N_DEFAULT  = 0.6;   /* distance decay exponent                       */
  var CS_A_DEFAULT  = 1.5;   /* airborne to surface conversion factor         */
  var CS_B_DEFAULT  = 0.4;   /* airborne to surface conversion exponent       */

  var INDEX_COLUMN = "Carbon efficiency index";
  var INDEX_UNITS  = "megapascal years per tonne of carbon dioxide equivalent";

  /* ===================================================================
   * SECTION 0 — small helpers (sf, parse_grade, erf, inv_erf)
   * =================================================================== */

  /** Safe float. Blanks, text and missing values give the default. */
  function sf(val, def) {
    if (def === undefined) { def = 0.0; }
    if (val === null || val === undefined || val === "") { return def; }
    var v = (typeof val === "number") ? val : parseFloat(String(val).replace(/,/g, ""));
    if (isNaN(v)) { return def; }
    return v;
  }

  /** Read a concrete grade out of a material name. "C32/40" -> [32, 40]. */
  function parseGrade(name) {
    var m = /C\s*(\d{2,3})\s*\/\s*(\d{2,3})/i.exec(String(name));
    if (m) { return [parseInt(m[1], 10), parseInt(m[2], 10)]; }
    return [null, null];
  }

  /**
   * Error function, to full double precision.
   *
   * JavaScript has no Math.erf, so this reproduces Python's math.erf using
   * the regularised lower incomplete gamma function:
   *     erf(x) = P(1/2, x^2)   for x >= 0,  and erf(-x) = -erf(x)
   * evaluated by its series below x^2 < 1.5 and by the Lentz continued
   * fraction above it. Agreement with math.erf is ~1e-15, so the chloride
   * results match Options A and B to every digit that gets displayed.
   */
  var _LN_SQRT_PI = 0.5723649429247001; /* log(gamma(0.5)) = log(sqrt(pi)) */

  function _gammpHalf(x2) {
    /* P(a, x2) with a = 0.5 */
    var a = 0.5;
    if (x2 <= 0) { return 0.0; }
    if (x2 < a + 1.0) {
      /* series representation */
      var ap = a, sum = 1.0 / a, del = sum;
      for (var n = 1; n <= 1000; n++) {
        ap += 1.0;
        del *= x2 / ap;
        sum += del;
        if (Math.abs(del) < Math.abs(sum) * 1e-17) { break; }
      }
      return sum * Math.exp(-x2 + a * Math.log(x2) - _LN_SQRT_PI);
    }
    /* continued fraction for Q(a, x2), then P = 1 - Q  (modified Lentz) */
    var FPMIN = 1e-300;
    var b = x2 + 1.0 - a, c = 1.0 / FPMIN, d = 1.0 / b, h = d;
    for (var i = 1; i <= 1000; i++) {
      var an = -i * (i - a);
      b += 2.0;
      d = an * d + b; if (Math.abs(d) < FPMIN) { d = FPMIN; }
      c = b + an / c;  if (Math.abs(c) < FPMIN) { c = FPMIN; }
      d = 1.0 / d;
      var delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1.0) < 1e-17) { break; }
    }
    var q = Math.exp(-x2 + a * Math.log(x2) - _LN_SQRT_PI) * h;
    return 1.0 - q;
  }

  function erf(x) {
    if (x === 0) { return 0.0; }
    var v = _gammpHalf(x * x);
    return x >= 0 ? v : -v;
  }

  /**
   * Inverse error function. Winitzki's initial guess, then Newton refinement
   * against erf() — identical structure to inv_erf() in the Python engine.
   */
  function invErf(y) {
    if (y <= -1.0) { return -Infinity; }
    if (y >=  1.0) { return  Infinity; }
    if (y === 0.0) { return 0.0; }
    var a = 0.147;
    var ln1 = Math.log(1.0 - y * y);
    var t1 = 2.0 / (Math.PI * a) + ln1 / 2.0;
    var inner = Math.max(t1 * t1 - ln1 / a, 0.0);
    var x = Math.sqrt(Math.max(Math.sqrt(inner) - t1, 0.0));
    if (y < 0) { x = -x; }
    for (var i = 0; i < 60; i++) {
      var err = erf(x) - y;
      var d = 2.0 / Math.sqrt(Math.PI) * Math.exp(-x * x);
      if (d === 0) { break; }
      var step = err / d;
      x -= step;
      if (Math.abs(step) < 1e-14) { break; }
    }
    return x;
  }

  /* ===================================================================
   * SECTION 1 — unit logic and quantity take-off
   *             (port of project_engine.py)
   * =================================================================== */

  /**
   * Reads the dropdown unit text and returns a strict logic code.
   * Port of get_unit_logic_type() in app.py / app_desktop.py.
   */
  function getUnitLogicType(unitString) {
    var s = String(unitString === undefined || unitString === null ? "" : unitString).toLowerCase();
    if (s.indexOf("%") !== -1) {
      if (s.indexOf("wt") !== -1 || s.indexOf("weight") !== -1) { return "PERCENT_WEIGHT"; }
      return "PERCENT_VOL";
    }
    if (s.indexOf("/ unit") !== -1 || s.indexOf("/unit") !== -1) { return "PER_UNIT"; }
    if (s.indexOf("l/m3") !== -1) { return "LITER_PER_M3"; }
    if (s.trim() === "l" || s.trim() === "liters" || s.trim() === "litres") { return "BASIC_LITER"; }
    if (s.indexOf("uhpc") !== -1) { return "UHPC_REF_VOL"; }
    return "BASIC";
  }

  /** Port of _calculate_total_volume() in project_engine.py. */
  function calculateTotalVolume(volStr, unitStr, numUnits, refVol, refWeight) {
    var vol = sf(volStr, 0.0);
    if (vol === 0) { return 0.0; }
    var logic = getUnitLogicType(unitStr);
    if (logic === "UHPC_REF_VOL")   { return refVol    ? vol * refVol : 0.0; }
    if (logic === "PERCENT_VOL")    { return refVol    ? (vol / 100.0) * refVol : 0.0; }
    if (logic === "PERCENT_WEIGHT") { return refWeight ? (vol / 100.0) * refWeight : 0.0; }
    if (logic === "PER_UNIT")       { return vol * numUnits; }
    return vol;
  }

  /**
   * Density and GWP factor of a named material.
   * Port of calculate_mix_carbon() in app.py.
   * Returns { "Mass (kg/m3)", "Factor_GWP (kgCO2e/kg)", EEF, ECF }.
   */
  function calcMixCarbon(mixName, db, userMixes) {
    var mMass = 0.0, mGwp = 0.0, mEe = 0.0, mEc = 0.0;
    var factors = indexBy(db.factors, "Component");
    var i, c, val, fr;

    if (String(mixName).indexOf("Custom: ") === 0) {
      var mixN = String(mixName).replace("Custom: ", "");
      var match = null;
      for (i = 0; i < (userMixes || []).length; i++) {
        if (userMixes[i].mix_name === mixN) { match = userMixes[i]; break; }
      }
      if (match) {
        var comps = match.components || {};
        for (c in comps) {
          if (!Object.prototype.hasOwnProperty.call(comps, c)) { continue; }
          val = sf(comps[c]);
          fr = factors[c];
          if (fr) {
            mGwp += val * sf(fr.ECFGWP100_kgCO2e_kg);
            mEe  += val * sf(fr.EEF_MJ_kg);
            mEc  += val * sf(fr.ECF_kgCO2_kg);
          }
          mMass += val;
        }
        var adhocs = match.adhoc_materials || [];
        for (i = 0; i < adhocs.length; i++) {
          var q = sf(adhocs[i].Quantity);
          mMass += q;
          mGwp  += q * sf(adhocs[i]["GWP100 (kgCO2e/kg)"]);
          mEe   += q * sf(adhocs[i]["EEF (MJ/kg)"]);
          mEc   += q * sf(adhocs[i]["ECF (kgCO2/kg)"]);
        }
      }
    } else {
      var mix = findRow(db.mixes, "Mix_Key", mixName);
      if (mix) {
        for (c in factors) {
          if (!Object.prototype.hasOwnProperty.call(factors, c)) { continue; }
          if (mix[c] === undefined || mix[c] === null || mix[c] === "") { continue; }
          val = sf(mix[c]);
          fr = factors[c];
          mMass += val;
          mGwp  += val * sf(fr.ECFGWP100_kgCO2e_kg);
          mEe   += val * sf(fr.EEF_MJ_kg);
          mEc   += val * sf(fr.ECF_kgCO2_kg);
        }
      } else {
        var dir = findRow(db.direct, "Material_Key", mixName);
        if (dir) {
          mMass = sf(dir.Total_Mass_kg_m3, 1.0);
          if (mMass === 0) { mMass = 1.0; }
          mGwp = sf(dir.GWP100_kgCO2e_m3, 0.0);
          if (mGwp === 0.0) { mGwp = sf(dir.ECFGWP100_kgCO2e_kg) * mMass; }
          mEe = sf(dir.EEF_MJ_kg) * mMass;
          mEc = sf(dir.ECF_kgCO2_kg) * mMass;
        }
      }
    }

    return {
      "Mass (kg/m3)": mMass,
      "Factor_GWP (kgCO2e/kg)": mMass > 0 ? mGwp / mMass : 0,
      "Factor_EE (MJ/kg)":      mMass > 0 ? mEe  / mMass : 0,
      "Factor_EC (kgCO2/kg)":   mMass > 0 ? mEc  / mMass : 0
    };
  }

  /**
   * The main quantity take-off.
   * Port of calculate_project_rows() in project_engine.py.
   *
   * uiData = { structure: "...", components: { "Girders": {Concrete_mat, Concrete_vol,
   *            Concrete_unit, Rebars_vol, ..., number_of_units}, ... } }
   *
   * Returns { rows, totals, errors }.
   */
  function calculateProjectRows(db, userMixes, uiData) {
    var rows = [], errors = [];
    var grand = { Total_Mass_kg:0.0, Total_EE_GJ:0.0,
                  Total_EC_kgCO2:0.0, Total_GWP100_kgCO2e:0.0 };

    var concreteVolumes = {};
    var steelWeights = {};
    var totalUhpcVolume = 0.0;
    var components = (uiData && uiData.components) || {};
    var name, cd;

    /* ---- pre-scan: concrete volume per component + steel base weights ---- */
    for (name in components) {
      if (!Object.prototype.hasOwnProperty.call(components, name)) { continue; }
      cd = components[name];
      var numUnits = parseInt(sf(cd.number_of_units, 1), 10) || 1;

      if (cd.Concrete_vol !== undefined) {
        var matKey = cd.Concrete_mat || "";
        var concVol = calculateTotalVolume(cd.Concrete_vol, cd.Concrete_unit, numUnits);
        concreteVolumes[name] = concVol;
        if (String(matKey).toUpperCase().indexOf("UHPC") !== -1) {
          totalUhpcVolume += concVol;
        }
      }
      if (cd.Steel_vol !== undefined) {
        var steelT = calculateTotalVolume(cd.Steel_vol, cd.Steel_unit, numUnits);
        var lt = getUnitLogicType(cd.Steel_unit);
        if (lt === "BASIC" || lt === "PER_UNIT") { steelWeights[name] = steelT; }
      }
    }

    /* ---- main pass ---- */
    for (name in components) {
      if (!Object.prototype.hasOwnProperty.call(components, name)) { continue; }
      cd = components[name];
      var nUnits = parseInt(sf(cd.number_of_units, 1), 10) || 1;
      var concRef = concreteVolumes[name] || 0.0;
      var steelRef = steelWeights["Main Girders"] || 0.0;

      /* closure captures the component context, exactly like the Python
         default-argument trick in process_item() */
      var processItem = (function (componentName, numUnits, concRefVol, steelRefWeight) {
        return function (itemName, materialKeyFull, volStr, unitStr) {
          if (!materialKeyFull || String(materialKeyFull).indexOf("--- Select") !== -1) { return; }
          var volInput = sf(volStr, 0.0);
          if (volInput === 0) { return; }

          var props = materialProperties(db, userMixes, materialKeyFull);
          if (!props) {
            errors.push("Material key '" + materialKeyFull + "' (" + itemName +
                        ") was not found in the database and was skipped.");
            return;
          }
          if (props.category && String(props.category).toLowerCase() === "other" &&
              sf(props.Total_Mass_kg_m3) === 0) { return; }

          var logic = getUnitLogicType(unitStr);
          var refVol = (logic === "PERCENT_VOL") ? concRefVol
                     : (logic === "UHPC_REF_VOL") ? totalUhpcVolume : null;
          var refWeight = (logic === "PERCENT_WEIGHT") ? steelRefWeight : null;

          var totalVol = calculateTotalVolume(volStr, unitStr, numUnits, refVol, refWeight);

          var massPerM3 = sf(props.Total_Mass_kg_m3);
          var massKg;
          if ((logic === "BASIC" || logic === "PER_UNIT") &&
              String(unitStr).indexOf("tonnes") !== -1) {
            massKg = totalVol * 1000;
          } else if (logic === "PERCENT_WEIGHT") {
            massKg = totalVol * 1000;
          } else {
            if (logic === "BASIC_LITER" || logic === "UHPC_REF_VOL") {
              totalVol = totalVol / 1000.0;
            }
            massKg = totalVol * massPerM3;
          }

          var eeGj    = (massKg * sf(props.EEF_MJ_kg)) / 1000;
          var ecKg    =  massKg * sf(props.ECF_kgCO2_kg);
          var gwpKg   =  massKg * sf(props.ECFGWP100_kgCO2e_kg);

          grand.Total_Mass_kg        += massKg;
          grand.Total_EE_GJ          += eeGj;
          grand.Total_EC_kgCO2       += ecKg;
          grand.Total_GWP100_kgCO2e  += gwpKg;

          rows.push({
            component: componentName, item_name: itemName,
            material: materialKeyFull, volume_input: volInput, unit: unitStr,
            volume_m3: (String(unitStr).indexOf("tonnes") !== -1) ? null : totalVol,
            mass_kg: massKg, ee_gj: eeGj, ec_kgco2: ecKg, gwp_kgco2e: gwpKg
          });
        };
      })(name, nUnits, concRef, steelRef);

      if (cd.Concrete_vol   !== undefined) { processItem(name + " Concrete",     cd.Concrete_mat, cd.Concrete_vol,   cd.Concrete_unit); }
      if (cd.Rebars_vol     !== undefined) { processItem(name + " Rebars",       "Steel",         cd.Rebars_vol,     cd.Rebars_unit); }
      if (cd.Strands_vol    !== undefined) { processItem(name + " Strands",      "Steel",         cd.Strands_vol,    cd.Strands_unit); }
      if (cd.Steel_vol      !== undefined) { processItem(name + " Steel",        "Steel",         cd.Steel_vol,      cd.Steel_unit); }
      if (cd.Bracing_vol    !== undefined) { processItem(name + " Bracing",      "Steel",         cd.Bracing_vol,    cd.Bracing_unit); }
      if (cd.Bolts_Nuts_vol !== undefined) { processItem(name + " Bolts & Nuts", "Steel",         cd.Bolts_Nuts_vol, cd.Bolts_Nuts_unit); }

      if (name === "Extra") {
        var lines = String(cd.extra_materials || "").split(/\r?\n/);
        for (var li = 0; li < lines.length; li++) {
          var line = lines[li];
          if (!line.trim()) { continue; }
          var parts = line.split(",").map(function (p) { return p.trim(); });
          if (parts.length !== 4) {
            errors.push("Skipped malformed 'Extra' line: " + line);
            continue;
          }
          processItem("Extra: " + parts[0], parts[1], parts[2], parts[3]);
        }
      }
    }

    return { rows: rows, totals: grand, errors: errors };
  }

  /**
   * Find the physical properties of a material by key, whether it is a mix
   * recipe, a direct material or a user's custom mix.
   * Equivalent to get_material_properties_by_key() in app_desktop.py.
   */
  function materialProperties(db, userMixes, key) {
    var dir = findRow(db.direct, "Material_Key", key);
    if (dir) {
      return {
        Total_Mass_kg_m3: sf(dir.Total_Mass_kg_m3),
        EEF_MJ_kg: sf(dir.EEF_MJ_kg),
        ECF_kgCO2_kg: sf(dir.ECF_kgCO2_kg),
        ECFGWP100_kgCO2e_kg: sf(dir.ECFGWP100_kgCO2e_kg),
        category: dir.Category || ""
      };
    }
    var mix = findRow(db.mixes, "Mix_Key", key);
    if (mix || String(key).indexOf("Custom: ") === 0) {
      var p = calcMixCarbon(key, db, userMixes);
      if (sf(p["Mass (kg/m3)"]) <= 0) { return null; }
      return {
        Total_Mass_kg_m3: p["Mass (kg/m3)"],
        EEF_MJ_kg: p["Factor_EE (MJ/kg)"],
        ECF_kgCO2_kg: p["Factor_EC (kgCO2/kg)"],
        ECFGWP100_kgCO2e_kg: p["Factor_GWP (kgCO2e/kg)"],
        category: "Concrete"
      };
    }
    return null;
  }

  /* ===================================================================
   * SECTION 2 — structural class and minimum durability cover
   *             (EN 1992-1-1, driven entirely by the rulebook)
   * =================================================================== */

  /** Port of structural_class(). Returns an integer 1..6. */
  function structuralClass(exposureClass, fckCyl, designLifeYears,
                           specialQualityControl, rules) {
    var exp = String(exposureClass).toUpperCase();
    var s = 4, i, r;

    for (i = 0; i < rules.length; i++) {
      if (String(rules[i].Rule_Type).toUpperCase() === "BASE") {
        s = Math.round(sf(rules[i].Class_Adjustment, 4));
        break;
      }
    }

    for (i = 0; i < rules.length; i++) {
      r = rules[i];
      var rule = String(r.Rule_Type || "").toUpperCase();
      var scope = String(r.Exposure_Class === undefined ? "ALL" : r.Exposure_Class).toUpperCase();
      if (scope !== "ALL" && scope !== exp) { continue; }
      var param = sf(r.Parameter, 0.0);
      var adj = Math.round(sf(r.Class_Adjustment, 0));

      if (rule === "DESIGN_LIFE" && param > 0 && sf(designLifeYears, 50) >= param) {
        s += adj;
      } else if (rule === "STRENGTH" && param > 0 && sf(fckCyl) >= param) {
        s += adj;
      } else if (rule === "QUALITY_CONTROL" && specialQualityControl) {
        s += adj;
      }
    }
    return Math.max(1, Math.min(6, s));
  }

  /** Port of minimum_durability_cover(). Returns cmin,dur in mm. */
  function minimumDurabilityCover(exposureClass, classLabel, elementType, coverTable) {
    if (String(classLabel).toLowerCase().indexOf("not") === 0) { return 0.0; }
    for (var i = 0; i < coverTable.length; i++) {
      var r = coverTable[i];
      if (String(r.Structural_Class).toUpperCase() === String(classLabel).toUpperCase() &&
          String(r.Exposure_Class).toUpperCase() === String(exposureClass).toUpperCase() &&
          String(r.Element_Type).toLowerCase() === String(elementType).toLowerCase()) {
        return sf(r.cmin_dur_mm);
      }
    }
    return 0.0;
  }

  /* ===================================================================
   * SECTION 3 — strength lookup and coefficient defaults
   * =================================================================== */

  /** Port of get_strength(). */
  function getStrength(materialName, db, gradeOverride) {
    var grade = gradeOverride ? gradeOverride : materialName;
    var out = { Grade:"", fck_cyl:0.0, fck_cube:0.0, fcm_cyl:0.0, fcm_cube:0.0 };
    var g = parseGrade(grade);
    if (g[0] === null) { return out; }
    out.Grade = "C" + g[0] + "/" + g[1];

    var tbl = db.strength_classes || [];
    for (var i = 0; i < tbl.length; i++) {
      if (sf(tbl[i].fck_cyl_MPa) === g[0]) {
        out.fck_cyl  = sf(tbl[i].fck_cyl_MPa);
        out.fck_cube = sf(tbl[i].fck_cube_MPa);
        out.fcm_cyl  = sf(tbl[i].fcm_cyl_MPa);
        out.fcm_cube = sf(tbl[i].fcm_cube_MPa);
        return out;
      }
    }
    out.fck_cyl = g[0]; out.fck_cube = g[1];
    out.fcm_cyl = g[0] + 8.0; out.fcm_cube = g[1] + 8.0;
    return out;
  }

  /** Port of _nearest_by_grade(): exact grade match, else nearest fck. */
  function nearestByGrade(table, gradeCol, valueCol, gradeLabel, fck) {
    var i;
    for (i = 0; i < table.length; i++) {
      if (String(table[i][gradeCol]).trim().toUpperCase() ===
          String(gradeLabel).trim().toUpperCase()) {
        return sf(table[i][valueCol]);
      }
    }
    var best = null, bestD = Infinity;
    for (i = 0; i < table.length; i++) {
      var f = parseGrade(table[i][gradeCol])[0] || 0;
      var d = Math.abs(f - sf(fck));
      if (d < bestD) { bestD = d; best = table[i]; }
    }
    return best ? sf(best[valueCol]) : 0.0;
  }

  function defaultCarbonationCoefficient(gradeLabel, fckCyl, fcmCyl, db) {
    var d = db.carbonation_k400_defaults || [];
    if (d.length) {
      var val = nearestByGrade(d, "Grade", "k400_default", gradeLabel, fckCyl);
      if (val > 0) { return Math.round(val * 1000) / 1000; }
    }
    var lit = db.carbonation_k400 || [];
    if (lit.length) {
      var tmp = lit.slice();
      if (tmp[0] && tmp[0].fcm_cyl_MPa !== undefined) {
        tmp.sort(function (a, b) {
          return Math.abs(sf(a.fcm_cyl_MPa) - sf(fcmCyl)) -
                 Math.abs(sf(b.fcm_cyl_MPa) - sf(fcmCyl));
        });
        tmp = tmp.slice(0, 8);
      }
      var vals = tmp.map(function (r) { return sf(r.k400); })
                    .sort(function (a, b) { return a - b; });
      if (vals.length) {
        var n = vals.length;
        var med = (n % 2) ? vals[Math.floor(n / 2)]
                          : (vals[n / 2 - 1] + vals[n / 2]) / 2.0;
        return Math.round(med * 1000) / 1000;
      }
    }
    return 0.0;
  }

  function defaultDiffusionCoefficient(gradeLabel, fckCyl, db) {
    var d = db.chloride_dc || [];
    if (!d.length) { return 0.0; }
    return nearestByGrade(d, "Grade", "Dc_x1e6_mm2_s", gradeLabel, fckCyl);
  }

  /* ===================================================================
   * SECTION 4 — binder content from the mix design
   * =================================================================== */

  function roleOf(componentName, binderMap) {
    var n = String(componentName || "").trim().toLowerCase();
    if (!n) { return null; }
    var roles = ["ADDITIVE", "CEMENT"], i, j;
    for (i = 0; i < roles.length; i++) {
      for (j = 0; j < binderMap.length; j++) {
        if (String(binderMap[j].Role).toUpperCase() !== roles[i]) { continue; }
        var kw = String(binderMap[j].Component_Keyword).trim().toLowerCase();
        if (kw && n.indexOf(kw) !== -1) { return roles[i]; }
      }
    }
    return null;
  }

  /** Port of autofill_binder(). Returns { cement, additive, found }. */
  function autofillBinder(materialName, db, userMixes) {
    var bmap = db.binder_mapping || [];
    var cement = 0.0, additive = 0.0, found = false;
    var role, c, i;

    if (String(materialName).indexOf("Custom: ") === 0) {
      var mixN = String(materialName).replace("Custom: ", "");
      var match = null;
      for (i = 0; i < (userMixes || []).length; i++) {
        if (userMixes[i].mix_name === mixN) { match = userMixes[i]; break; }
      }
      if (match) {
        var comps = match.components || {};
        for (c in comps) {
          if (!Object.prototype.hasOwnProperty.call(comps, c)) { continue; }
          role = roleOf(c, bmap);
          if (role === "CEMENT")   { cement   += sf(comps[c]); found = true; }
          if (role === "ADDITIVE") { additive += sf(comps[c]); found = true; }
        }
        var adhocs = match.adhoc_materials || [];
        for (i = 0; i < adhocs.length; i++) {
          role = roleOf(adhocs[i]["Material Name"], bmap);
          if (role === "CEMENT")   { cement   += sf(adhocs[i].Quantity); found = true; }
          if (role === "ADDITIVE") { additive += sf(adhocs[i].Quantity); found = true; }
        }
      }
      return { cement: cement, additive: additive, found: found };
    }

    var mix = findRow(db.mixes, "Mix_Key", materialName);
    if (mix) {
      if (mix.Cement_Content_kg_m3 !== undefined && mix.Cement_Content_kg_m3 !== null) {
        cement = sf(mix.Cement_Content_kg_m3); found = true;
      }
      if (mix.Additive_Content_kg_m3 !== undefined && mix.Additive_Content_kg_m3 !== null) {
        additive = sf(mix.Additive_Content_kg_m3); found = true;
      }
      if (found) { return { cement: cement, additive: additive, found: true }; }

      var factors = indexBy(db.factors, "Component");
      for (c in factors) {
        if (!Object.prototype.hasOwnProperty.call(factors, c)) { continue; }
        if (mix[c] === undefined || mix[c] === null || mix[c] === "") { continue; }
        role = roleOf(c, bmap);
        if (role === "CEMENT")   { cement   += sf(mix[c]); found = true; }
        if (role === "ADDITIVE") { additive += sf(mix[c]); found = true; }
      }
      return { cement: cement, additive: additive, found: found };
    }

    var dir = findRow(db.direct, "Material_Key", materialName);
    if (dir) {
      if (dir.Cement_Content_kg_m3 !== undefined && dir.Cement_Content_kg_m3 !== null) {
        cement = sf(dir.Cement_Content_kg_m3); found = true;
      }
      if (dir.Additive_Content_kg_m3 !== undefined && dir.Additive_Content_kg_m3 !== null) {
        additive = sf(dir.Additive_Content_kg_m3); found = true;
      }
    }
    return { cement: cement, additive: additive, found: found };
  }

  /* ===================================================================
   * SECTION 5 — THE PHYSICS
   * =================================================================== */

  /**
   * Site carbonation coefficient, mm per square root of a year.
   *     k = k400 * sqrt(k1 * k2)
   */
  function carbonationCoefficient(k400, k1, k2) {
    return sf(k400) * Math.sqrt(Math.max(sf(k1) * sf(k2), 0.0));
  }

  /**
   * Carbonation service life. Depassivation when the front reaches the bar:
   *     x(t) = k * sqrt(t)   ->   t = (cover / k)^2
   */
  function carbonationLife(coverMm, k) {
    if (sf(k) <= 0) { return Infinity; }
    return Math.pow(sf(coverMm) / sf(k), 2);
  }

  /**
   * Surface chloride concentration, kg per m3, from distance to the coast.
   *     airborne salt = c1 * d^(-n)
   *     surface value = a * (airborne)^b
   * With the published constants this collapses to
   *     Cs = 1.22279 * d^(-0.24)
   * giving 6.417 kg/m3 at one metre and 0.704 kg/m3 at ten kilometres.
   */
  function surfaceChlorideFromDistance(dKm, c1, n, a, b) {
    c1 = (c1 === undefined) ? CS_C1_DEFAULT : c1;
    n  = (n  === undefined) ? CS_N_DEFAULT  : n;
    a  = (a  === undefined) ? CS_A_DEFAULT  : a;
    b  = (b  === undefined) ? CS_B_DEFAULT  : b;
    var d = Math.max(sf(dKm), 1e-6);
    return a * Math.pow(c1 * Math.pow(d, -n), b);
  }

  /** The single leading constant of the collapsed power law. */
  function collapsedConstant(c1, a, b) {
    c1 = (c1 === undefined) ? CS_C1_DEFAULT : c1;
    a  = (a  === undefined) ? CS_A_DEFAULT  : a;
    b  = (b  === undefined) ? CS_B_DEFAULT  : b;
    return a * Math.pow(sf(c1, CS_C1_DEFAULT), b);
  }

  /**
   * Chloride service life from Fick's second law with an error-function
   * solution:
   *     C(x,t) = Cs * [1 - erf( x / (2*sqrt(Da*t)) )]
   * Setting C = Ctl and solving for t:
   *     erf(y) = 1 - Ctl/Cs ,  y = inverf(1 - Ctl/Cs)
   *     t = x^2 / (4 * Da * y^2)      [seconds, then converted to years]
   *
   * Returns [lifeYears, erfValue, invErfValue, status].
   */
  function chlorideLife(coverMm, dcE6, threshold, surface) {
    surface = sf(surface); threshold = sf(threshold);
    if (surface <= 0)        { return [NaN, NaN, NaN, "NO_SURFACE"]; }
    if (threshold >= surface){ return [Infinity, 0.0, Infinity, "NOT_CRITICAL"]; }
    var erfY = 1.0 - threshold / surface;
    var y = invErf(erfY);
    var da = sf(dcE6) * 1e-6;                       /* -> mm2/s */
    if (da <= 0 || y <= 0 || !isFinite(y)) { return [Infinity, erfY, y, "NOT_CRITICAL"]; }
    var life = Math.pow(sf(coverMm), 2) / (4.0 * da * y * y) / SECONDS_PER_YEAR;
    return [life, erfY, y, "OK"];
  }

  /**
   * Carbon efficiency index (CSEPP), in MPa-years per tonne CO2e:
   *     index = fck * design life / embodied carbon
   * Higher is better: more strength held for longer, per tonne of carbon.
   */
  function carbonEfficiencyIndex(fck, designLife, embodiedCarbonTonnes) {
    if (sf(embodiedCarbonTonnes) <= 0) { return NaN; }
    return sf(fck) * sf(designLife) / sf(embodiedCarbonTonnes);
  }

  /* ===================================================================
   * SECTION 6 — grouping and carbon allocation
   * =================================================================== */

  /** Port of group_component_materials(): one row per component + material. */
  function groupComponentMaterials(projectRows, db, userMixes) {
    if (!projectRows || !projectRows.length) { return []; }
    var map = {}, i, r, key;
    for (i = 0; i < projectRows.length; i++) {
      r = projectRows[i];
      key = r.component + "\u0000" + r.material;
      if (!map[key]) {
        map[key] = { Component:r.component, Material:r.material,
                     mass:0, gwp:0, vol:0 };
      }
      map[key].mass += sf(r.mass_kg);
      map[key].gwp  += sf(r.gwp_kgco2e);
      map[key].vol  += sf(r.volume_m3);
    }
    var out = [];
    for (key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) { continue; }
      var g = map[key];
      var props = calcMixCarbon(g.Material, db, userMixes);
      var density = sf(props["Mass (kg/m3)"]);
      var vol = g.vol;
      if (vol <= 0) { vol = density > 0 ? g.mass / density : 0.0; }
      out.push({
        "Component": g.Component,
        "Material": g.Material,
        "Density (kg per m3)": density,
        "Volume (m3)": vol,
        "Mass (kg)": g.mass,
        "Embodied carbon (kg CO2e)": g.gwp,
        "Embodied carbon (tonne CO2e)": g.gwp / 1000.0,
        "Is Concrete": parseGrade(g.Material)[0] !== null
      });
    }
    out.sort(function (a, b) {
      if (a.Component === b.Component) { return a.Material < b.Material ? -1 : 1; }
      return a.Component < b.Component ? -1 : 1;
    });
    return out;
  }

  /** Port of group_project_materials(): one row per material, whole project. */
  function groupProjectMaterials(projectRows, db, userMixes) {
    var cm = groupComponentMaterials(projectRows, db, userMixes);
    var map = {}, i;
    for (i = 0; i < cm.length; i++) {
      var m = cm[i].Material;
      if (!map[m]) {
        map[m] = { "Material":m, "Density (kg per m3)":cm[i]["Density (kg per m3)"],
                   "Volume (m³)":0, "Mass (kg)":0, "GWP100 (kgCO2e)":0,
                   "EIC (tonne CO2e)":0, "Is Concrete":cm[i]["Is Concrete"] };
      }
      map[m]["Volume (m³)"]      += cm[i]["Volume (m3)"];
      map[m]["Mass (kg)"]        += cm[i]["Mass (kg)"];
      map[m]["GWP100 (kgCO2e)"]  += cm[i]["Embodied carbon (kg CO2e)"];
      map[m]["EIC (tonne CO2e)"] += cm[i]["Embodied carbon (tonne CO2e)"];
    }
    var out = [];
    for (var k in map) {
      if (Object.prototype.hasOwnProperty.call(map, k)) { out.push(map[k]); }
    }
    out.sort(function (a, b) { return b["GWP100 (kgCO2e)"] - a["GWP100 (kgCO2e)"]; });
    return out;
  }

  /**
   * Port of allocate_component_carbon().
   * Charges the carbon of every supporting material in a component (rebar,
   * strands, formwork, diesel...) onto that component's concrete, split by
   * concrete volume share. This is what makes the efficiency index fair:
   * a mix that needs less steel is credited for it.
   */
  function allocateComponentCarbon(cmAll, concreteMaterials) {
    var byComp = {}, i, order = [];
    for (i = 0; i < cmAll.length; i++) {
      var c = cmAll[i].Component;
      if (!byComp[c]) { byComp[c] = []; order.push(c); }
      byComp[c].push(cmAll[i]);
    }
    var rows = [];
    for (var oi = 0; oi < order.length; oi++) {
      var comp = order[oi];
      var g = byComp[comp];
      var conc = [], other = [];
      for (i = 0; i < g.length; i++) {
        if (concreteMaterials.indexOf(g[i].Material) !== -1) { conc.push(g[i]); }
        else { other.push(g[i]); }
      }
      var otherCarbon = 0, otherNames = [];
      for (i = 0; i < other.length; i++) {
        otherCarbon += sf(other[i]["Embodied carbon (tonne CO2e)"]);
        otherNames.push(String(other[i].Material));
      }
      var totVol = 0;
      for (i = 0; i < conc.length; i++) { totVol += sf(conc[i]["Volume (m3)"]); }
      var n = conc.length;
      for (i = 0; i < conc.length; i++) {
        var share = totVol > 0 ? sf(conc[i]["Volume (m3)"]) / totVol : (n ? 1.0 / n : 0.0);
        var own = sf(conc[i]["Embodied carbon (tonne CO2e)"]);
        rows.push({
          "Component": comp,
          "Material": conc[i].Material,
          "Volume (m3)": sf(conc[i]["Volume (m3)"]),
          "Concrete carbon (tonne CO2e)": own,
          "Supporting carbon (tonne CO2e)": otherCarbon * share,
          "Total embodied carbon (tonne CO2e)": own + otherCarbon * share,
          "Supporting materials": otherNames.length ? otherNames.join(", ") : "None"
        });
      }
    }
    return rows;
  }

  /* ===================================================================
   * SECTION 7 — the input grid
   * =================================================================== */

  var COL = {
    COMPONENT:"Component", MATERIAL:"Material", GRADE:"Concrete grade",
    FCK:"Characteristic cylinder strength (MPa)", FCM:"Mean cube strength (MPa)",
    ELEMENT:"Element type", CLASS:"Structural class",
    CEMENT:"Cement content (kg/m3)", ADDITIVE:"Additive content (kg/m3)",
    K400:"Reference carbonation coefficient (mm/year^0.5)",
    CTL:"Chloride threshold level (% of binder)",
    DC:"Chloride diffusion coefficient (x10-6 mm2/s)",
    CMIN:"Minimum durability cover (mm)", COVER:"Concrete cover used (mm)",
    LIFE:"Used design life (years)"
  };

  var CALCULATED_COLUMNS = [COL.GRADE, COL.CMIN];

  function expectedColumns(mechanism) {
    var order = [COL.COMPONENT, COL.MATERIAL, COL.GRADE, COL.FCK, COL.FCM,
                 COL.ELEMENT, COL.CLASS, COL.CEMENT, COL.ADDITIVE];
    order = order.concat(mechanism === "CARBONATION" ? [COL.K400] : [COL.CTL, COL.DC]);
    return order.concat([COL.CMIN, COL.COVER, COL.LIFE]);
  }

  /** Port of build_input_table(). */
  function buildInputTable(allocRows, mechanism, exposureClass, db, userMixes,
                           designLife, coverAllowance, specialQualityControl) {
    var cache = {}, rows = [];
    for (var i = 0; i < allocRows.length; i++) {
      var m = allocRows[i];
      var name = m.Material;
      if (!cache[name]) {
        var s = getStrength(name, db);
        var b = autofillBinder(name, db, userMixes);
        cache[name] = {
          s: s, cem: b.cement, add: b.additive, found: b.found,
          k400: defaultCarbonationCoefficient(s.Grade, s.fck_cyl, s.fcm_cyl, db),
          dc: defaultDiffusionCoefficient(s.Grade, s.fck_cyl, db)
        };
      }
      var c = cache[name];
      var sCls = "S" + structuralClass(exposureClass, c.s.fck_cyl, designLife,
                                       specialQualityControl, db.structural_class_rules);
      var cmin = minimumDurabilityCover(exposureClass, sCls, "Reinforced", db.cover_requirements);

      var row = {};
      row[COL.COMPONENT] = m.Component;
      row[COL.MATERIAL]  = name;
      row[COL.GRADE]     = c.s.Grade ? c.s.Grade : "Not recognised";
      row[COL.FCK]       = c.s.fck_cyl;
      row[COL.FCM]       = c.s.fcm_cube;
      row[COL.ELEMENT]   = "Reinforced";
      row[COL.CLASS]     = "Automatic";
      row[COL.CEMENT]    = c.found ? c.cem : null;
      row[COL.ADDITIVE]  = c.found ? c.add : null;
      if (mechanism === "CARBONATION") {
        row[COL.K400] = c.k400;
      } else {
        row[COL.CTL] = 0.40;
        row[COL.DC]  = c.dc;
      }
      row[COL.CMIN]  = cmin;
      row[COL.COVER] = cmin + sf(coverAllowance, 10.0);
      row[COL.LIFE]  = parseFloat(designLife);
      rows.push(row);
    }
    return rows;
  }

  /** Port of refresh_derived(): recompute class and cover after edits. */
  function refreshDerived(rows, exposureClass, coverAllowance,
                          specialQualityControl, db) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var chosen = String(r[COL.CLASS] === undefined ? "Automatic" : r[COL.CLASS]);
      var label;
      if (chosen.toLowerCase().indexOf("not") === 0) {
        label = "Not applicable";
      } else if (chosen.toUpperCase().charAt(0) === "S" && chosen.length <= 2) {
        label = chosen.toUpperCase();
      } else {
        label = "S" + structuralClass(exposureClass, r[COL.FCK], r[COL.LIFE],
                                      specialQualityControl, db.structural_class_rules);
      }
      var cmin = minimumDurabilityCover(exposureClass, label,
                                        r[COL.ELEMENT] || "Reinforced", db.cover_requirements);
      var oldCmin = sf(r[COL.CMIN]);
      var cover = sf(r[COL.COVER]);
      /* Only auto-follow the cover if the user has not typed their own value */
      if (Math.abs(cover - (oldCmin + sf(coverAllowance, 10.0))) < 1e-6 && cmin > 0) {
        cover = cmin + sf(coverAllowance, 10.0);
      }
      r._resolved_class = label;
      r[COL.CMIN] = cmin;
      r[COL.COVER] = cover;
    }
    return rows;
  }

  /* ===================================================================
   * SECTION 8 — running the assessment
   * =================================================================== */

  function pick(alloc, component, material, col) {
    var total = 0;
    for (var i = 0; i < alloc.length; i++) {
      if (alloc[i].Component === component && alloc[i].Material === material) {
        total += sf(alloc[i][col]);
      }
    }
    return total;
  }

  function carbonColumns(alloc, r) {
    var c = r[COL.COMPONENT], m = r[COL.MATERIAL];
    return {
      "Volume (m3)": pick(alloc, c, m, "Volume (m3)"),
      "Concrete carbon (tonne CO2e)": pick(alloc, c, m, "Concrete carbon (tonne CO2e)"),
      "Supporting carbon (tonne CO2e)": pick(alloc, c, m, "Supporting carbon (tonne CO2e)"),
      "Total embodied carbon (tonne CO2e)": pick(alloc, c, m, "Total embodied carbon (tonne CO2e)")
    };
  }

  /** Port of run_carbonation(). */
  function runCarbonation(edited, alloc, k1, k2) {
    var out = [];
    for (var i = 0; i < edited.length; i++) {
      var r = edited[i];
      var binder = sf(r[COL.CEMENT]) + sf(r[COL.ADDITIVE]);
      var cover = sf(r[COL.COVER]);
      var k = carbonationCoefficient(r[COL.K400], k1, k2);
      var life = carbonationLife(cover, k);
      var used = sf(r[COL.LIFE], 100.0);
      var row = {
        "Component": r[COL.COMPONENT], "Material": r[COL.MATERIAL],
        "Concrete grade": r[COL.GRADE] || "",
        "Characteristic cylinder strength (MPa)": sf(r[COL.FCK]),
        "Structural class": r._resolved_class || "",
        "Total binder content (kg per m3)": binder,
        "Reference carbonation coefficient": sf(r[COL.K400]),
        "Site carbonation coefficient": k,
        "Minimum durability cover (mm)": sf(r[COL.CMIN]),
        "Concrete cover used (mm)": cover,
        "Calculated design life (years)": life,
        "Used design life (years)": used,
        "Durability check": (cover > 0 && life >= used) ? "PASS" : "FAIL"
      };
      var cc = carbonColumns(alloc, r);
      for (var k2n in cc) { if (Object.prototype.hasOwnProperty.call(cc, k2n)) { row[k2n] = cc[k2n]; } }
      out.push(row);
    }
    return out;
  }

  /** Port of run_chloride(). */
  function runChloride(edited, alloc, surfaceChloride) {
    var out = [];
    for (var i = 0; i < edited.length; i++) {
      var r = edited[i];
      var binder = sf(r[COL.CEMENT]) + sf(r[COL.ADDITIVE]);
      var threshold = sf(r[COL.CTL]) / 100.0 * binder;
      var cover = sf(r[COL.COVER]);
      var res = chlorideLife(cover, r[COL.DC], threshold, surfaceChloride);
      var life = res[0], erfY = res[1], y = res[2], status = res[3];
      var used = sf(r[COL.LIFE], 100.0);
      var row = {
        "Component": r[COL.COMPONENT], "Material": r[COL.MATERIAL],
        "Concrete grade": r[COL.GRADE] || "",
        "Characteristic cylinder strength (MPa)": sf(r[COL.FCK]),
        "Structural class": r._resolved_class || "",
        "Total binder content (kg per m3)": binder,
        "Chloride threshold level (%)": sf(r[COL.CTL]),
        "Threshold concentration (kg per m3)": threshold,
        "Surface concentration (kg per m3)": sf(surfaceChloride),
        "Error function value": erfY,
        "Inverse error function value": y,
        "Chloride diffusion coefficient": sf(r[COL.DC]),
        "Minimum durability cover (mm)": sf(r[COL.CMIN]),
        "Concrete cover used (mm)": cover,
        "Calculated design life (years)": life,
        "Used design life (years)": used,
        "Chloride status": status === "NOT_CRITICAL" ? "Chloride not critical"
                         : status === "NO_SURFACE"   ? "No surface value"
                         : "Chloride governs",
        "Durability check": (cover > 0 && life >= used) ? "PASS" : "FAIL"
      };
      var cc = carbonColumns(alloc, r);
      for (var kk in cc) { if (Object.prototype.hasOwnProperty.call(cc, kk)) { row[kk] = cc[kk]; } }
      out.push(row);
    }
    return out;
  }

  /** Port of material_summary(): roll the per-component rows up per material. */
  function materialSummary(detail) {
    var byMat = {}, order = [], i;
    for (i = 0; i < detail.length; i++) {
      var m = detail[i].Material;
      if (!byMat[m]) { byMat[m] = []; order.push(m); }
      byMat[m].push(detail[i]);
    }
    var rows = [];
    for (var oi = 0; oi < order.length; oi++) {
      var g = byMat[order[oi]];
      var used = Infinity, carbon = 0, vol = 0, cc = 0, sc = 0;
      var minLife = Infinity, allPass = true, comps = [];
      for (i = 0; i < g.length; i++) {
        used = Math.min(used, sf(g[i]["Used design life (years)"], 100.0));
        carbon += sf(g[i]["Total embodied carbon (tonne CO2e)"]);
        vol += sf(g[i]["Volume (m3)"]);
        cc += sf(g[i]["Concrete carbon (tonne CO2e)"]);
        sc += sf(g[i]["Supporting carbon (tonne CO2e)"]);
        var l = g[i]["Calculated design life (years)"];
        if (!isNaN(l) && l < minLife) { minLife = l; }
        if (g[i]["Durability check"] !== "PASS") { allPass = false; }
        comps.push(String(g[i].Component));
      }
      if (!isFinite(used)) { used = 100.0; }
      var fck = sf(g[0]["Characteristic cylinder strength (MPa)"]);
      rows.push({
        "Material": order[oi],
        "Concrete grade": g[0]["Concrete grade"],
        "Characteristic cylinder strength (MPa)": fck,
        "Components": comps.join(", "),
        "Volume (m3)": vol,
        "Concrete carbon (tonne CO2e)": cc,
        "Supporting carbon (tonne CO2e)": sc,
        "Total embodied carbon (tonne CO2e)": carbon,
        "Governing calculated life (years)": minLife,
        "Used design life (years)": used,
        "Durability check": allPass ? "PASS" : "FAIL",
        "Carbon efficiency index": allPass ? carbonEfficiencyIndex(fck, used, carbon) : NaN
      });
    }
    return rows;
  }

  /** Port of structure_summary(): the whole-structure headline numbers. */
  function structureSummary(matRes) {
    var i, totalCarbon = 0, totalVolume = 0, weightedNum = 0;
    var life = Infinity, nPass = 0, sumIndex = 0, cc = 0, sc = 0;
    for (i = 0; i < matRes.length; i++) {
      var r = matRes[i];
      totalCarbon += sf(r["Total embodied carbon (tonne CO2e)"]);
      totalVolume += sf(r["Volume (m3)"]);
      cc += sf(r["Concrete carbon (tonne CO2e)"]);
      sc += sf(r["Supporting carbon (tonne CO2e)"]);
      weightedNum += sf(r["Characteristic cylinder strength (MPa)"]) * sf(r["Volume (m3)"]);
      life = Math.min(life, sf(r["Used design life (years)"]));
      if (r["Durability check"] === "PASS") {
        nPass++;
        var idx = r["Carbon efficiency index"];
        if (!isNaN(idx) && isFinite(idx)) { sumIndex += idx; }
      }
    }
    if (!matRes.length) { life = 0; }
    var weightedFck = totalVolume > 0 ? weightedNum / totalVolume : 0.0;
    var whole = totalCarbon > 0 ? weightedFck * life / totalCarbon : NaN;
    return {
      n_materials: matRes.length, n_pass: nPass,
      all_pass: (nPass === matRes.length) && matRes.length > 0,
      total_volume: totalVolume, total_carbon: totalCarbon,
      concrete_carbon: cc, supporting_carbon: sc,
      sum_index: sumIndex, weighted_fck: weightedFck,
      structure_index: whole, governing_life: isFinite(life) ? life : 0
    };
  }

  /* ===================================================================
   * SECTION 9 — tiny data utilities (stand-ins for pandas)
   * =================================================================== */

  function findRow(table, col, value) {
    if (!table) { return null; }
    for (var i = 0; i < table.length; i++) {
      if (String(table[i][col]).trim() === String(value).trim()) { return table[i]; }
    }
    return null;
  }

  function indexBy(table, col) {
    var out = {};
    for (var i = 0; i < (table || []).length; i++) {
      var k = table[i][col];
      if (k !== undefined && out[k] === undefined) { out[k] = table[i]; }
    }
    return out;
  }

  /* ===================================================================
   * public surface
   * =================================================================== */
  return {
    SECONDS_PER_YEAR: SECONDS_PER_YEAR,
    INDEX_COLUMN: INDEX_COLUMN, INDEX_UNITS: INDEX_UNITS,
    COL: COL, CALCULATED_COLUMNS: CALCULATED_COLUMNS,
    sf: sf, parseGrade: parseGrade, erf: erf, invErf: invErf,
    getUnitLogicType: getUnitLogicType, calculateTotalVolume: calculateTotalVolume,
    calcMixCarbon: calcMixCarbon, materialProperties: materialProperties,
    calculateProjectRows: calculateProjectRows,
    structuralClass: structuralClass, minimumDurabilityCover: minimumDurabilityCover,
    getStrength: getStrength, autofillBinder: autofillBinder,
    defaultCarbonationCoefficient: defaultCarbonationCoefficient,
    defaultDiffusionCoefficient: defaultDiffusionCoefficient,
    carbonationCoefficient: carbonationCoefficient, carbonationLife: carbonationLife,
    surfaceChlorideFromDistance: surfaceChlorideFromDistance,
    collapsedConstant: collapsedConstant,
    chlorideLife: chlorideLife, carbonEfficiencyIndex: carbonEfficiencyIndex,
    groupComponentMaterials: groupComponentMaterials,
    groupProjectMaterials: groupProjectMaterials,
    allocateComponentCarbon: allocateComponentCarbon,
    buildInputTable: buildInputTable, expectedColumns: expectedColumns,
    refreshDerived: refreshDerived,
    runCarbonation: runCarbonation, runChloride: runChloride,
    materialSummary: materialSummary, structureSummary: structureSummary,
    findRow: findRow, indexBy: indexBy
  };
})();

if (typeof module !== "undefined" && module.exports) { module.exports = ENGINE; }
