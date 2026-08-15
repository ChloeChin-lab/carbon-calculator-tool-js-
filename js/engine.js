/* =====================================================================
 * engine.js  —  Option C (Static Browser App)   [CORRECTED]
 * ---------------------------------------------------------------------
 * A direct port of the two Python engines used by Options A and B:
 *
 *   app.py  ->  get_unit_logic_type(), calculate_mix_carbon(),
 *               calculate_project_data()
 *   service_life.py -> carbonation, chloride, structural class, minimum
 *               cover, carbon allocation, carbon efficiency index
 *
 * WHAT WAS WRONG BEFORE (and is fixed here)
 * -----------------------------------------
 * 1. The take-off invented its own reference values. Python asks the user
 *    for a reference volume/weight per material row (ref_value, and a
 *    "x Qty" flag). The old JS silently used the component's concrete
 *    volume instead, so every "%" row was wrong.
 * 2. LITER_PER_M3 was recognised but never implemented, so "L/m3" rows
 *    fell through to BASIC and were out by a factor of the reference
 *    volume and by 1000.
 * 3. "kg" units were not handled at all; they were multiplied by density.
 * 4. Volume was recorded as null for anything typed in tonnes. Python
 *    always reports volume = mass / density, which is what the durability
 *    allocation needs to split supporting carbon by volume share.
 * 5. A "UHPC_REF_VOL" logic type existed here that does not exist in the
 *    Python engine; it has been removed.
 * 6. The component multiplier was read from a single flat field. Python
 *    keeps a count per component and multiplies PER_UNIT rows by it.
 *
 * Nothing here touches the DOM and nothing here touches storage.
 * ===================================================================== */

var ENGINE = (function () {
  "use strict";

  var SECONDS_PER_YEAR = 365.25 * 24 * 3600.0;

  /* Airborne chloride model constants (service_life.py lines 41-44) */
  var CS_C1_DEFAULT = 0.6;   /* calibration constant of the airborne salt law */
  var CS_N_DEFAULT  = 0.6;   /* distance decay exponent                       */
  var CS_A_DEFAULT  = 1.5;   /* airborne to surface conversion factor         */
  var CS_B_DEFAULT  = 0.4;   /* airborne to surface conversion exponent       */

  var INDEX_COLUMN = "Carbon efficiency index";
  var INDEX_UNITS  = "megapascal years per tonne of carbon dioxide equivalent";

  var SELECT_PLACEHOLDER = "--- Select ---";

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
   * Error function, to full double precision. JavaScript has no Math.erf,
   * so this reproduces Python's math.erf through the regularised lower
   * incomplete gamma function: erf(x) = P(1/2, x^2) for x >= 0.
   */
  var _LN_SQRT_PI = 0.5723649429247001;

  function _gammpHalf(x2) {
    var a = 0.5;
    if (x2 <= 0) { return 0.0; }
    if (x2 < a + 1.0) {
      var ap = a, sum = 1.0 / a, del = sum;
      for (var n = 1; n <= 1000; n++) {
        ap += 1.0;
        del *= x2 / ap;
        sum += del;
        if (Math.abs(del) < Math.abs(sum) * 1e-17) { break; }
      }
      return sum * Math.exp(-x2 + a * Math.log(x2) - _LN_SQRT_PI);
    }
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
    return 1.0 - Math.exp(-x2 + a * Math.log(x2) - _LN_SQRT_PI) * h;
  }

  function erf(x) {
    if (x === 0) { return 0.0; }
    var v = _gammpHalf(x * x);
    return x >= 0 ? v : -v;
  }

  /** Inverse error function. Winitzki guess, then Newton against erf(). */
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
   *             (exact port of app.py)
   * =================================================================== */

  /**
   * Port of get_unit_logic_type() in app.py. Reads the unit text the user
   * picked and returns the logic code the arithmetic branches on.
   *
   *   "% by conc. vol."  -> PERCENT_VOL
   *   "% of wt."         -> PERCENT_WEIGHT   (any "wt" or "weight")
   *   "tonnes / unit"    -> PER_UNIT
   *   "L/m3"             -> LITER_PER_M3
   *   "L"                -> BASIC_LITER
   *   anything else      -> BASIC
   */
  function getUnitLogicType(unitString) {
    var s = String(unitString === undefined || unitString === null ? "" : unitString).toLowerCase();
    if (s.indexOf("%") !== -1) {
      if (s.indexOf("wt") !== -1 || s.indexOf("weight") !== -1) { return "PERCENT_WEIGHT"; }
      return "PERCENT_VOL";
    }
    if (s.indexOf("/ unit") !== -1 || s.indexOf("/unit") !== -1) { return "PER_UNIT"; }
    if (s.indexOf("l/m3") !== -1 || s.indexOf("l/m³") !== -1) { return "LITER_PER_M3"; }
    var t = s.trim();
    if (t === "l" || t === "liter" || t === "liters" || t === "litre" || t === "litres") {
      return "BASIC_LITER";
    }
    return "BASIC";
  }

  /** True when the chosen unit needs the user to give a reference amount. */
  function needsReference(unitString) {
    var l = getUnitLogicType(unitString);
    return l === "PERCENT_VOL" || l === "PERCENT_WEIGHT" || l === "LITER_PER_M3";
  }

  /** The label the reference box should carry, as in app.py. */
  function referenceLabel(unitString) {
    return getUnitLogicType(unitString) === "PERCENT_WEIGHT"
      ? "Reference weight (tonnes)" : "Reference volume (m³)";
  }

  /**
   * The mass of one material line, in kilogrammes.
   * This is the arithmetic block of calculate_project_data(), lifted
   * one to one so the two apps agree to the last decimal.
   *
   *   PERCENT_VOL     volume  = qty/100 x reference volume, mass = volume x density
   *   LITER_PER_M3    litres  = qty x reference volume,     mass = litres/1000 x density
   *   PERCENT_WEIGHT  tonnes  = qty/100 x reference weight, mass = tonnes x 1000
   *   PER_UNIT        base    = qty x component count, then the BASIC rules
   *   BASIC           base    = qty, then: tonnes x1000, kg as typed,
   *                             litres /1000 x density, otherwise x density
   */
  function lineMassKg(qty, unitStr, count, density, refValue, refPerUnit) {
    qty = sf(qty, 0.0);
    if (qty <= 0) { return 0.0; }
    count = parseInt(sf(count, 1), 10) || 1;
    density = sf(density, 0.0);

    var logic = getUnitLogicType(unitStr);
    var u = String(unitStr || "").toLowerCase();

    if (logic === "PERCENT_VOL" || logic === "LITER_PER_M3" || logic === "PERCENT_WEIGHT") {
      var ref = sf(refValue, 0.0) * (refPerUnit ? count : 1);
      if (logic === "PERCENT_VOL")    { return (qty / 100.0) * ref * density; }
      if (logic === "LITER_PER_M3")   { return ((qty * ref) / 1000.0) * density; }
      return (qty / 100.0) * ref * 1000.0;                    /* PERCENT_WEIGHT */
    }

    var base = (logic === "PER_UNIT") ? qty * count : qty;
    if (u.indexOf("tonne") !== -1) { return base * 1000.0; }
    if (u.indexOf("kg") !== -1)    { return base; }
    if (logic === "BASIC_LITER")   { return (base / 1000.0) * density; }
    return base * density;
  }

  /**
   * Density and carbon/energy factors of a named material.
   * Port of calculate_mix_carbon() in app.py, extended with the embodied
   * energy and the embodied carbon factors that the Excel rulebook holds.
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
        var dir = findRow(db.direct, "Material_Key", mixName) ||
                  findByAlias(db.direct, mixName);
        if (dir) {
          mMass = sf(dir.Total_Mass_kg_m3, 1.0);
          if (mMass === 0) { mMass = 1.0; }
          mGwp = sf(dir.GWP100_kgCO2e_m3, 0.0);
          if (mGwp === 0.0) { mGwp = sf(dir.ECFGWP100_kgCO2e_kg) * mMass; }
          mEe = sf(dir.EE_GJ_m3, 0.0) * 1000.0;
          if (mEe === 0.0) { mEe = sf(dir.EEF_MJ_kg) * mMass; }
          mEc = sf(dir.EC_kgCO2_m3, 0.0);
          if (mEc === 0.0) { mEc = sf(dir.ECF_kgCO2_kg) * mMass; }
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
   * Normalise whatever shape the saved project is in into the list of
   * components the engine works with. Accepts:
   *   - the current shape:  { structure, components: [ {..}, {..} ] }
   *   - the old Option C shape: { structure, components: { "Girders": {...} } }
   * so that projects saved by an earlier build still open and still total.
   */
  function normaliseComponents(uiData) {
    var comps = (uiData && uiData.components) || [];
    if (Array.isArray(comps)) {
      return comps.map(function (c) {
        return {
          base_name:   c.base_name || c.custom_name || "Component",
          custom_name: c.custom_name || c.base_name || "Component",
          count:       parseInt(sf(c.count !== undefined ? c.count : c.multiplier_count, 1), 10) || 1,
          materials:   (c.materials || []).map(function (m) {
            return {
              label:        m.label || "",
              mix:          m.mix || m.assigned_mix || SELECT_PLACEHOLDER,
              qty:          sf(m.qty !== undefined ? m.qty : m.quantity, 0),
              unit:         m.unit || "m3",
              ref_value:    sf(m.ref_value, 0),
              ref_per_unit: !!m.ref_per_unit
            };
          })
        };
      });
    }

    /* legacy object-of-components shape */
    var out = [], name;
    var keys = ["Concrete", "Rebars", "Strands", "Steel", "Bracing", "Bolts_Nuts"];
    for (name in comps) {
      if (!Object.prototype.hasOwnProperty.call(comps, name)) { continue; }
      var cd = comps[name] || {};
      var mats = [];
      keys.forEach(function (k) {
        if (cd[k + "_vol"] === undefined) { return; }
        mats.push({
          label: k, mix: (k === "Concrete") ? (cd.Concrete_mat || SELECT_PLACEHOLDER) : "Steel",
          qty: sf(cd[k + "_vol"], 0), unit: cd[k + "_unit"] || "m3",
          ref_value: 0, ref_per_unit: false
        });
      });
      String(cd.extra_materials || "").split(/\r?\n/).forEach(function (line) {
        var p = line.split(",").map(function (x) { return x.trim(); });
        if (p.length === 4) {
          mats.push({ label: p[0], mix: p[1], qty: sf(p[2], 0), unit: p[3],
                      ref_value: 0, ref_per_unit: false });
        }
      });
      out.push({ base_name: name, custom_name: name,
                 count: parseInt(sf(cd.number_of_units, 1), 10) || 1, materials: mats });
    }
    return out;
  }

  /**
   * The main quantity take-off. Port of calculate_project_data().
   * Returns { rows, totals, errors }.
   */
  function calculateProjectRows(db, userMixes, uiData) {
    var rows = [], errors = [];
    var grand = { Total_Mass_kg: 0.0, Total_Volume_m3: 0.0, Total_EE_GJ: 0.0,
                  Total_EC_kgCO2: 0.0, Total_GWP100_kgCO2e: 0.0 };

    var components = normaliseComponents(uiData);

    for (var ci = 0; ci < components.length; ci++) {
      var comp = components[ci];
      var cName = comp.custom_name || comp.base_name || ("Component " + (ci + 1));
      var count = comp.count;

      for (var mi = 0; mi < comp.materials.length; mi++) {
        var mat = comp.materials[mi];
        var qty = sf(mat.qty, 0.0);
        var mix = mat.mix;

        if (!mix || mix === SELECT_PLACEHOLDER || String(mix).indexOf("--- Select") !== -1) { continue; }
        if (qty <= 0) { continue; }

        var props = calcMixCarbon(mix, db, userMixes);
        var density = sf(props["Mass (kg/m3)"]);
        if (density <= 0) {
          errors.push("'" + mix + "' (" + cName + (mat.label ? " " + mat.label : "") +
                      ") has no density in the database, so it was skipped.");
          continue;
        }

        var massKg = lineMassKg(qty, mat.unit, count, density,
                                mat.ref_value, mat.ref_per_unit);
        if (massKg === 0) { continue; }

        var volM3  = density > 0 ? massKg / density : 0.0;
        var gwpKg  = massKg * sf(props["Factor_GWP (kgCO2e/kg)"]);
        var eeGj   = massKg * sf(props["Factor_EE (MJ/kg)"]) / 1000.0;
        var ecKg   = massKg * sf(props["Factor_EC (kgCO2/kg)"]);

        grand.Total_Mass_kg       += massKg;
        grand.Total_Volume_m3     += volM3;
        grand.Total_EE_GJ         += eeGj;
        grand.Total_EC_kgCO2      += ecKg;
        grand.Total_GWP100_kgCO2e += gwpKg;

        var displayQty = needsReference(mat.unit)
          ? (qty + " (reference " + sf(mat.ref_value, 0) +
             (mat.ref_per_unit ? " x " + count : "") + ")")
          : String(qty);

        rows.push({
          component: cName,
          item_name: (ci + 1) + ". " + cName + (mat.label ? " " + mat.label : ""),
          material: mix,
          volume_input: qty,
          display_qty: displayQty,
          unit: mat.unit,
          volume_m3: volM3,
          mass_kg: massKg,
          ee_gj: eeGj,
          ec_kgco2: ecKg,
          gwp_kgco2e: gwpKg
        });
      }
    }

    return { rows: rows, totals: grand, errors: errors };
  }

  /**
   * Physical properties of a material by key, whether it is a mix recipe,
   * a direct material or a user's custom mix.
   */
  function materialProperties(db, userMixes, key) {
    var dir = findRow(db.direct, "Material_Key", key) || findByAlias(db.direct, key);
    if (dir) {
      var p0 = calcMixCarbon(dir.Material_Key, db, userMixes);
      return {
        Total_Mass_kg_m3: p0["Mass (kg/m3)"],
        EEF_MJ_kg: p0["Factor_EE (MJ/kg)"],
        ECF_kgCO2_kg: p0["Factor_EC (kgCO2/kg)"],
        ECFGWP100_kgCO2e_kg: p0["Factor_GWP (kgCO2e/kg)"],
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
   * =================================================================== */

  /** Port of structural_class(). Returns an integer 1..6. */
  function structuralClass(exposureClass, fckCyl, designLifeYears,
                           specialQualityControl, rules) {
    var exp = String(exposureClass).toUpperCase();
    var s = 4, i, r;
    rules = rules || [];

    for (i = 0; i < rules.length; i++) {
      if (String(rules[i].Rule_Type).toUpperCase() === "BASE") {
        s = Math.round(sf(rules[i].Class_Adjustment, 4));
        break;
      }
    }

    for (i = 0; i < rules.length; i++) {
      r = rules[i];
      var rule = String(r.Rule_Type || "").toUpperCase();
      var scope = String(r.Exposure_Class === undefined || r.Exposure_Class === null
                         ? "ALL" : r.Exposure_Class).toUpperCase();
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
    coverTable = coverTable || [];
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
    var out = { Grade: "", fck_cyl: 0.0, fck_cube: 0.0, fcm_cyl: 0.0, fcm_cube: 0.0 };
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

  /** Site carbonation coefficient: k = k400 * sqrt(k1 * k2). */
  function carbonationCoefficient(k400, k1, k2) {
    return sf(k400) * Math.sqrt(Math.max(sf(k1) * sf(k2), 0.0));
  }

  /** Carbonation life. x(t) = k sqrt(t)  ->  t = (cover / k)^2. */
  function carbonationLife(coverMm, k) {
    if (sf(k) <= 0) { return Infinity; }
    return Math.pow(sf(coverMm) / sf(k), 2);
  }

  /**
   * Surface chloride concentration from distance to the coast.
   *     airborne salt = c1 * d^(-n);  surface = a * (airborne)^b
   * With the published constants that collapses to 1.22279 * d^(-0.24),
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
   * Chloride life from Fick's second law:
   *     C(x,t) = Cs [1 - erf( x / (2 sqrt(Da t)) )]
   *     erf(y) = 1 - Ctl/Cs,   t = x^2 / (4 Da y^2)
   * Returns [lifeYears, erfValue, invErfValue, status].
   */
  function chlorideLife(coverMm, dcE6, threshold, surface) {
    surface = sf(surface); threshold = sf(threshold);
    if (surface <= 0)         { return [NaN, NaN, NaN, "NO_SURFACE"]; }
    if (threshold >= surface) { return [Infinity, 0.0, Infinity, "NOT_CRITICAL"]; }
    var erfY = 1.0 - threshold / surface;
    var y = invErf(erfY);
    var da = sf(dcE6) * 1e-6;                       /* -> mm2/s */
    if (da <= 0 || y <= 0 || !isFinite(y)) { return [Infinity, erfY, y, "NOT_CRITICAL"]; }
    var life = Math.pow(sf(coverMm), 2) / (4.0 * da * y * y) / SECONDS_PER_YEAR;
    return [life, erfY, y, "OK"];
  }

  /** Carbon efficiency index = fck * design life / embodied carbon. */
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
    var map = {}, order = [], i, r, key;
    for (i = 0; i < projectRows.length; i++) {
      r = projectRows[i];
      key = r.component + "\u0000" + r.material;
      if (!map[key]) {
        map[key] = { Component: r.component, Material: r.material, mass: 0, gwp: 0, vol: 0 };
        order.push(key);
      }
      map[key].mass += sf(r.mass_kg);
      map[key].gwp  += sf(r.gwp_kgco2e);
      map[key].vol  += sf(r.volume_m3);
    }
    var out = [];
    for (i = 0; i < order.length; i++) {
      var g = map[order[i]];
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
    var map = {}, order = [], i;
    for (i = 0; i < cm.length; i++) {
      var m = cm[i].Material;
      if (!map[m]) {
        map[m] = { "Material": m, "Density (kg per m3)": cm[i]["Density (kg per m3)"],
                   "Volume (m³)": 0, "Mass (kg)": 0, "GWP100 (kgCO2e)": 0,
                   "EIC (tonne CO2e)": 0, "Is Concrete": cm[i]["Is Concrete"] };
        order.push(m);
      }
      map[m]["Volume (m³)"]      += cm[i]["Volume (m3)"];
      map[m]["Mass (kg)"]        += cm[i]["Mass (kg)"];
      map[m]["GWP100 (kgCO2e)"]  += cm[i]["Embodied carbon (kg CO2e)"];
      map[m]["EIC (tonne CO2e)"] += cm[i]["Embodied carbon (tonne CO2e)"];
    }
    var out = order.map(function (k) { return map[k]; });
    out.sort(function (a, b) { return b["GWP100 (kgCO2e)"] - a["GWP100 (kgCO2e)"]; });
    return out;
  }

  /**
   * Port of allocate_component_carbon(). Charges the carbon of every
   * supporting material in a component onto that component's concrete,
   * split by concrete volume share.
   */
  function allocateComponentCarbon(cmAll, concreteMaterials) {
    var byComp = {}, i, order = [];
    cmAll = cmAll || [];
    concreteMaterials = concreteMaterials || [];
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
    COMPONENT: "Component", MATERIAL: "Material", GRADE: "Concrete grade",
    FCK: "Characteristic cylinder strength (MPa)", FCM: "Mean cube strength (MPa)",
    ELEMENT: "Element type", CLASS: "Structural class",
    CEMENT: "Cement content (kg/m3)", ADDITIVE: "Additive content (kg/m3)",
    K400: "Reference carbonation coefficient (mm/year^0.5)",
    CTL: "Chloride threshold level (% of binder)",
    DC: "Chloride diffusion coefficient (x10-6 mm2/s)",
    CMIN: "Minimum durability cover (mm)", COVER: "Concrete cover used (mm)",
    LIFE: "Used design life (years)"
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
      row[COL.LIFE]  = sf(designLife, 100.0);
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
      } else if (/^S[1-6]$/i.test(chosen.trim())) {
        label = chosen.trim().toUpperCase();
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
      for (var kn in cc) { if (Object.prototype.hasOwnProperty.call(cc, kn)) { row[kn] = cc[kn]; } }
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

  /** Port of material_summary(). */
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
      var row = {
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
        "Durability check": allPass ? "PASS" : "FAIL"
      };
      row[INDEX_COLUMN] = allPass ? carbonEfficiencyIndex(fck, used, carbon) : NaN;
      rows.push(row);
    }
    return rows;
  }

  /** Port of structure_summary(). */
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
        var idx = r[INDEX_COLUMN];
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

  /** The Direct_Results sheet carries an "Aliases" column. Honour it. */
  function findByAlias(table, value) {
    if (!table) { return null; }
    var v = String(value).trim().toLowerCase();
    for (var i = 0; i < table.length; i++) {
      var al = table[i].Aliases;
      if (!al) { continue; }
      var parts = String(al).split(",");
      for (var j = 0; j < parts.length; j++) {
        if (parts[j].trim().toLowerCase() === v) { return table[i]; }
      }
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
    SELECT_PLACEHOLDER: SELECT_PLACEHOLDER,
    COL: COL, CALCULATED_COLUMNS: CALCULATED_COLUMNS,
    sf: sf, parseGrade: parseGrade, erf: erf, invErf: invErf,
    getUnitLogicType: getUnitLogicType, needsReference: needsReference,
    referenceLabel: referenceLabel, lineMassKg: lineMassKg,
    calcMixCarbon: calcMixCarbon, materialProperties: materialProperties,
    normaliseComponents: normaliseComponents,
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
    findRow: findRow, findByAlias: findByAlias, indexBy: indexBy
  };
})();

if (typeof module !== "undefined" && module.exports) { module.exports = ENGINE; }
