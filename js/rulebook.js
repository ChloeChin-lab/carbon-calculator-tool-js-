/* =====================================================================
 * rulebook.js  —  Option C (Static Browser App)   [CORRECTED]
 * ---------------------------------------------------------------------
 * Everything that used to live in materials_database.xlsx, converted into
 * plain JavaScript objects and shipped with the app.
 *
 * WHAT CHANGED
 * ------------
 * 1. The structure templates now use the same column names as the
 *    Project_Structures worksheet that app.py reads
 *    (Structure_Name and a comma separated Components string), instead of
 *    a bespoke shape that only this file understood.
 * 2. A Unit_Logic fallback has been added, matching the worksheet, so the
 *    unit dropdown offered for each component is the one the spreadsheet
 *    specifies rather than one flat list for everything.
 * 3. The merge at the bottom no longer leaks loop variables into the
 *    global scope and no longer overwrites a good built-in table with an
 *    empty worksheet.
 * ===================================================================== */

var RULEBOOK = (function () {
  "use strict";

  /* ---------------------------------------------------------------
   * 1. Strength classes: fck_cube = fck_cyl + delta, fcm = fck + 8
   * --------------------------------------------------------------- */
  function buildStrengthTable() {
    var d = { 20:5,21:5,22:5,23:5,24:5,25:5,26:5,27:6,28:6,
              29:7,30:7,31:8,32:8,33:9,34:9 };
    for (var f = 35; f <= 51; f++) { d[f] = 10; }
    d[52] = 11; d[53] = 11; d[54] = 12; d[55] = 12;
    d[56] = 13; d[57] = 13; d[58] = 14; d[59] = 14;

    var rows = [];
    for (var fck = 20; fck <= 220; fck++) {
      var delta = (d[fck] === undefined) ? 15 : d[fck];
      var cube = fck + delta;
      rows.push({
        Grade: "C" + fck + "/" + cube,
        fck_cyl_MPa: fck,
        fck_cube_MPa: cube,
        fcm_cyl_MPa: fck + 8,
        fcm_cube_MPa: cube + 8
      });
    }
    return rows;
  }

  /* ---------------------------------------------------------------
   * 2. Exposure classes (EN 206 / EN 1992-1-1) — decides which model runs
   * --------------------------------------------------------------- */
  var EXPOSURE = [
    { Class:"X0",  Group:"No risk", Description:"No risk of corrosion or attack", Mechanism:"NONE" },
    { Class:"XC1", Group:"Carbonation", Description:"Dry or permanently wet", Mechanism:"CARBONATION" },
    { Class:"XC2", Group:"Carbonation", Description:"Wet, rarely dry", Mechanism:"CARBONATION" },
    { Class:"XC3", Group:"Carbonation", Description:"Moderate humidity, sheltered from rain", Mechanism:"CARBONATION" },
    { Class:"XC4", Group:"Carbonation", Description:"Cyclic wet and dry, exposed to rain", Mechanism:"CARBONATION" },
    { Class:"XD1", Group:"Chloride other than sea water", Description:"Moderate humidity", Mechanism:"CHLORIDE" },
    { Class:"XD2", Group:"Chloride other than sea water", Description:"Wet, rarely dry", Mechanism:"CHLORIDE" },
    { Class:"XD3", Group:"Chloride other than sea water", Description:"Cyclic wet and dry, de icing spray", Mechanism:"CHLORIDE" },
    { Class:"XS1", Group:"Sea water chloride", Description:"Airborne salt, no direct contact with sea water", Mechanism:"CHLORIDE" },
    { Class:"XS2", Group:"Sea water chloride", Description:"Permanently submerged in sea water", Mechanism:"CHLORIDE" },
    { Class:"XS3", Group:"Sea water chloride", Description:"Tidal, splash and spray zones", Mechanism:"CHLORIDE" }
  ];

  /* ---------------------------------------------------------------
   * 3. Location k1 — local CO2 concentration against the 400 ppm reference
   * --------------------------------------------------------------- */
  var LOCATION_K1 = [
    { Location_Type:"Coastal",  k1_default:0.90, Note:"Literature value" },
    { Location_Type:"Rural",    k1_default:1.00, Note:"Reference baseline" },
    { Location_Type:"Suburban", k1_default:1.30, Note:"Literature value" },
    { Location_Type:"Urban",    k1_default:1.40, Note:"Literature value" },
    { Location_Type:"Internal", k1_default:2.00, Note:"Enclosed environment" },
    { Location_Type:"Kuala Lumpur city centre, 2019", k1_default:1.06,
      Note:"436 ppm against a 410 ppm baseline" }
  ];

  /* ---------------------------------------------------------------
   * 4. Reference carbonation coefficient k400 (mm / year^0.5)
   * --------------------------------------------------------------- */
  var K400_DEFAULTS = [
    { Grade:"C140/155", Concrete_Type:"UHPC", k400_default:0.50, Note:"Adopted design value" },
    { Grade:"C70/85",   Concrete_Type:"HSC",  k400_default:2.00, Note:"Adopted design value" },
    { Grade:"C32/40",   Concrete_Type:"NSC",  k400_default:3.00, Note:"Adopted design value" },
    { Grade:"C40/50",   Concrete_Type:"NSC",  k400_default:3.00, Note:"Adopted design value" }
  ];

  /* ---------------------------------------------------------------
   * 5. Chloride diffusion coefficient Dc (x 1e-6 mm2/s)
   * --------------------------------------------------------------- */
  var CHLORIDE_DC = [
    { Grade:"C32/40",   Dc_x1e6_mm2_s:10.0, Source:"Case study value" },
    { Grade:"C40/50",   Dc_x1e6_mm2_s:6.0,  Source:"Case study value" },
    { Grade:"C70/85",   Dc_x1e6_mm2_s:4.5,  Source:"Case study value" },
    { Grade:"C140/155", Dc_x1e6_mm2_s:0.1,  Source:"NF P 18-470" }
  ];

  /* ---------------------------------------------------------------
   * 6. Binder mapping — which mix ingredients count as binder
   * --------------------------------------------------------------- */
  var BINDER_MAPPING = [
    { Role:"CEMENT",   Component_Keyword:"OP Cement" },
    { Role:"CEMENT",   Component_Keyword:"OPC" },
    { Role:"CEMENT",   Component_Keyword:"CEM I" },
    { Role:"CEMENT",   Component_Keyword:"Portland Cement" },
    { Role:"CEMENT",   Component_Keyword:"Cement" },
    { Role:"ADDITIVE", Component_Keyword:"Fly Ash" },
    { Role:"ADDITIVE", Component_Keyword:"PFA" },
    { Role:"ADDITIVE", Component_Keyword:"Silica Fume" },
    { Role:"ADDITIVE", Component_Keyword:"Microsilica" }
  ];

  /* ---------------------------------------------------------------
   * 7. Minimum durability cover cmin,dur (EN 1992-1-1 Table 4.4N/4.5N)
   *    Prestressed = reinforced + 10 mm.
   * --------------------------------------------------------------- */
  var FB_COVER_RC = {
    1: [10,10,10,15,20,25,30],
    2: [10,10,15,20,25,30,35],
    3: [10,10,20,25,30,35,40],
    4: [10,15,25,30,35,40,45],
    5: [15,20,30,35,40,45,50],
    6: [20,25,35,40,45,50,55]
  };
  var FB_EXP_COL = { "X0":0,"XC1":1,"XC2":2,"XC3":2,"XC4":3,
                     "XD1":4,"XS1":4,"XD2":5,"XS2":5,"XD3":6,"XS3":6 };

  function buildCoverTable() {
    var rows = [], s, exp;
    for (s = 1; s <= 6; s++) {
      for (exp in FB_EXP_COL) {
        if (!Object.prototype.hasOwnProperty.call(FB_EXP_COL, exp)) { continue; }
        var col = FB_EXP_COL[exp];
        rows.push({ Structural_Class:"S"+s, Exposure_Class:exp,
                    Element_Type:"Reinforced",  cmin_dur_mm: FB_COVER_RC[s][col] });
        rows.push({ Structural_Class:"S"+s, Exposure_Class:exp,
                    Element_Type:"Prestressed", cmin_dur_mm: FB_COVER_RC[s][col] + 10 });
      }
    }
    return rows;
  }

  /* ---------------------------------------------------------------
   * 8. Structural class rules (EN 1992-1-1 Table 4.3N logic)
   * --------------------------------------------------------------- */
  function buildRules() {
    var rows = [
      { Rule_Type:"BASE",            Exposure_Class:"ALL", Parameter:null, Class_Adjustment: 4, Description:"Starting structural class" },
      { Rule_Type:"DESIGN_LIFE",     Exposure_Class:"ALL", Parameter:100,  Class_Adjustment: 2, Description:"Design life of 100 years or more" },
      { Rule_Type:"QUALITY_CONTROL", Exposure_Class:"ALL", Parameter:null, Class_Adjustment:-1, Description:"Special quality control assured" }
    ];
    var thr = { "X0":30,"XC1":30,"XC2":35,"XC3":35,"XC4":40,"XD1":40,
                "XS1":40,"XD2":40,"XS2":45,"XD3":45,"XS3":45 };
    for (var exp in thr) {
      if (!Object.prototype.hasOwnProperty.call(thr, exp)) { continue; }
      rows.push({ Rule_Type:"STRENGTH", Exposure_Class:exp, Parameter:thr[exp],
                  Class_Adjustment:-1, Description:"Strength class at or above the threshold" });
    }
    return rows;
  }

  /* ---------------------------------------------------------------
   * 9. Unit logic — the units each component may be measured in.
   *    Same columns as the Unit_Logic worksheet.
   * --------------------------------------------------------------- */
  var UNIT_LOGIC = [
    { Component_Name:"Girders",        Unit_Options:"m3,m3 / unit",                        Default_Unit:"m3 / unit" },
    { Component_Name:"Deck",           Unit_Options:"m3",                                  Default_Unit:"m3" },
    { Component_Name:"Parapets",       Unit_Options:"m3,m3 / unit",                        Default_Unit:"m3 / unit" },
    { Component_Name:"End-Diaphragms", Unit_Options:"m3,m3 / unit",                        Default_Unit:"m3 / unit" },
    { Component_Name:"Rebars",         Unit_Options:"tonnes,tonnes / unit,% by conc. vol.", Default_Unit:"% by conc. vol." },
    { Component_Name:"Strands",        Unit_Options:"tonnes,tonnes / unit",                Default_Unit:"tonnes / unit" },
    { Component_Name:"Extra",          Unit_Options:"tonnes,L,m3",                         Default_Unit:"tonnes" },
    { Component_Name:"Foundations",    Unit_Options:"m3",                                  Default_Unit:"m3" },
    { Component_Name:"Columns",        Unit_Options:"m3",                                  Default_Unit:"m3" },
    { Component_Name:"Beams",          Unit_Options:"m3",                                  Default_Unit:"m3" },
    { Component_Name:"Slabs",          Unit_Options:"m3",                                  Default_Unit:"m3" },
    { Component_Name:"Main Girders",   Unit_Options:"tonnes,tonnes / unit",                Default_Unit:"tonnes / unit" },
    { Component_Name:"Bracing",        Unit_Options:"tonnes,% of wt.",                     Default_Unit:"% of wt." },
    { Component_Name:"Bolts & Nuts",   Unit_Options:"tonnes,% of wt.",                     Default_Unit:"% of wt." }
  ];

  /* Offered on every component after the sheet's own options. */
  var MASTER_UNITS = ["m3", "m3 / unit", "tonnes", "tonnes / unit", "kg",
                      "L", "L/m3", "% by conc. vol.", "% of wt.", "m", "m2", "units"];

  /* ---------------------------------------------------------------
   * 10. Column help text — the little marker on each grid heading
   * --------------------------------------------------------------- */
  var COLUMN_HELP = {
    "Concrete grade": "Read from the material name, for example C32/40. Drives every strength lookup.",
    "Characteristic cylinder strength (MPa)": "fck,cyl. Used for the structural class rule and for the carbon efficiency index.",
    "Mean cube strength (MPa)": "fcm,cube = fck,cube + 8 MPa.",
    "Element type": "Reinforced or Prestressed. Prestressed adds 10 mm to the minimum durability cover.",
    "Structural class": "Automatic applies the EN 1992-1-1 rules. Choose S1 to S6 to force a value.",
    "Cement content (kg/m3)": "Filled in from the mix design. Part of the binder total used by the chloride threshold.",
    "Additive content (kg/m3)": "Fly ash, silica fume and similar. Added to the cement to give the binder total.",
    "Reference carbonation coefficient (mm/year^0.5)": "k400, measured at the 400 ppm reference. Multiplied by the square root of k1 k2 to get the site value.",
    "Chloride threshold level (% of binder)": "The chloride mass that starts corrosion, as a percentage of the binder. 0.40 is the usual design value.",
    "Chloride diffusion coefficient (x10-6 mm2/s)": "Dc from the apparent diffusion test. Lower is denser and slower.",
    "Minimum durability cover (mm)": "cmin,dur looked up from the structural class and the exposure class.",
    "Concrete cover used (mm)": "The cover you will actually build. Starts at cmin,dur plus the deviation allowance.",
    "Used design life (years)": "The life you want to credit. Compared against the calculated life to give PASS or FAIL."
  };

  /* ---------------------------------------------------------------
   * 11. Starter materials library
   * --------------------------------------------------------------- */
  var FACTORS = [
    { Component:"OP Cement",        Density_kg_m3:3150, EEF_MJ_kg:5.50,  ECF_kgCO2_kg:0.830, ECFGWP100_kgCO2e_kg:0.912 },
    { Component:"Fly Ash",          Density_kg_m3:2300, EEF_MJ_kg:0.10,  ECF_kgCO2_kg:0.008, ECFGWP100_kgCO2e_kg:0.009 },
    { Component:"Silica Fume",      Density_kg_m3:2200, EEF_MJ_kg:0.036, ECF_kgCO2_kg:0.014, ECFGWP100_kgCO2e_kg:0.014 },
    { Component:"Fine Aggregate",   Density_kg_m3:2600, EEF_MJ_kg:0.081, ECF_kgCO2_kg:0.0048,ECFGWP100_kgCO2e_kg:0.0051 },
    { Component:"Coarse Aggregate", Density_kg_m3:2600, EEF_MJ_kg:0.083, ECF_kgCO2_kg:0.0052,ECFGWP100_kgCO2e_kg:0.0057 },
    { Component:"Water",            Density_kg_m3:1000, EEF_MJ_kg:0.20,  ECF_kgCO2_kg:0.0008,ECFGWP100_kgCO2e_kg:0.0009 },
    { Component:"Superplasticiser", Density_kg_m3:1070, EEF_MJ_kg:18.30, ECF_kgCO2_kg:0.720, ECFGWP100_kgCO2e_kg:0.944 },
    { Component:"Steel Fibre",      Density_kg_m3:7840, EEF_MJ_kg:36.40, ECF_kgCO2_kg:2.320, ECFGWP100_kgCO2e_kg:2.450 }
  ];

  var MIXES = [
    { Category:"NSC",  Mix_Key:"C32/40 NSC",
      "OP Cement":380, "Fly Ash":0,  "Silica Fume":0,
      "Fine Aggregate":700, "Coarse Aggregate":1100, "Water":180,
      "Superplasticiser":2.5, "Steel Fibre":0 },
    { Category:"NSC",  Mix_Key:"C40/50 NSC",
      "OP Cement":420, "Fly Ash":60, "Silica Fume":0,
      "Fine Aggregate":680, "Coarse Aggregate":1080, "Water":170,
      "Superplasticiser":3.5, "Steel Fibre":0 },
    { Category:"HSC",  Mix_Key:"C70/85 HSC",
      "OP Cement":480, "Fly Ash":80, "Silica Fume":40,
      "Fine Aggregate":640, "Coarse Aggregate":1020, "Water":150,
      "Superplasticiser":8.0, "Steel Fibre":0 },
    { Category:"UHPC", Mix_Key:"C140/155 UHPC",
      "OP Cement":760, "Fly Ash":0,  "Silica Fume":190,
      "Fine Aggregate":1030,"Coarse Aggregate":0,    "Water":180,
      "Superplasticiser":35.0,"Steel Fibre":160 }
  ];

  var DIRECT = [
    { Material_Key:"Steel", Category:"Metal", Aliases:"Rebars, Rebar, Strands",
      Total_Mass_kg_m3:7850, EEF_MJ_kg:24.40,
      ECF_kgCO2_kg:1.550, ECFGWP100_kgCO2e_kg:1.740 },
    { Material_Key:"Stainless Steel", Category:"Metal", Aliases:null,
      Total_Mass_kg_m3:7900, EEF_MJ_kg:56.70,
      ECF_kgCO2_kg:2.800, ECFGWP100_kgCO2e_kg:6.150 },
    { Material_Key:"Asphalt", Category:"Other", Aliases:"Surfacing",
      Total_Mass_kg_m3:2350, EEF_MJ_kg:2.860,
      ECF_kgCO2_kg:0.059, ECFGWP100_kgCO2e_kg:0.066 },
    { Material_Key:"Diesel", Category:"Fuel", Aliases:"diesel, fuel",
      Total_Mass_kg_m3:835, EEF_MJ_kg:45.40,
      ECF_kgCO2_kg:3.010, ECFGWP100_kgCO2e_kg:3.240 },
    { Material_Key:"Timber Formwork", Category:"Other", Aliases:"Formwork",
      Total_Mass_kg_m3:500, EEF_MJ_kg:10.00,
      ECF_kgCO2_kg:0.300, ECFGWP100_kgCO2e_kg:0.310 }
  ];

  /* Project templates, in the shape of the Project_Structures worksheet. */
  var STRUCTURES = [
    { Structure_Name:"Concrete Girder Bridge",
      Components:"Girders, Deck, End-Diaphragms, Parapets, Rebars, Strands" },
    { Structure_Name:"Steel Girder Bridge",
      Components:"Main Girders, Bracing, Bolts & Nuts, Deck, Parapets, Rebars" },
    { Structure_Name:"Building Frame",
      Components:"Foundations, Columns, Beams, Slabs, Rebars" }
  ];

  return {
    strength_classes:          buildStrengthTable(),
    exposure_classes:          EXPOSURE,
    location_k1:               LOCATION_K1,
    carbonation_k400_defaults: K400_DEFAULTS,
    carbonation_k400:          [],
    chloride_dc:               CHLORIDE_DC,
    binder_mapping:            BINDER_MAPPING,
    cover_requirements:        buildCoverTable(),
    structural_class_rules:    buildRules(),
    column_descriptions:       COLUMN_HELP,
    unit_logic:                UNIT_LOGIC,
    master_units:              MASTER_UNITS,
    factors:                   FACTORS,
    mixes:                     MIXES,
    direct:                    DIRECT,
    structures:                STRUCTURES,
    _source:                   "Built-in rulebook (bundled with the app)"
  };
})();

/* If tools/convert_excel_to_rulebook.py has produced rulebook_data.js it
   defines RULEBOOK_DATA, and we merge it over the built-in tables. An empty
   worksheet never replaces a working built-in table. */
(function mergeConvertedRulebook() {
  "use strict";
  if (typeof RULEBOOK_DATA === "undefined" || !RULEBOOK_DATA) { return; }
  var replaced = 0;
  for (var key in RULEBOOK_DATA) {
    if (!Object.prototype.hasOwnProperty.call(RULEBOOK_DATA, key)) { continue; }
    var value = RULEBOOK_DATA[key];
    if (!value) { continue; }
    if (Array.isArray(value) && value.length === 0) { continue; }
    if (!Array.isArray(value) && typeof value === "object" &&
        Object.keys(value).length === 0) { continue; }
    RULEBOOK[key] = value;
    replaced++;
  }
  if (replaced) {
    RULEBOOK._source = "Converted from the client spreadsheet (" +
                       replaced + " tables)";
  }
})();
