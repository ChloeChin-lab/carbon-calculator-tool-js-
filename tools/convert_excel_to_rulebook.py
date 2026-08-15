#!/usr/bin/env python3
"""
convert_excel_to_rulebook.py
=============================
Turns the client's Excel rulebook into the JavaScript file that Option C
ships with, so the browser app needs no server and no spreadsheet at runtime.

This is the ONE build step Option C has. You run it whenever the material
factors, mix designs or durability reference tables change — roughly as
often as you would re-upload the sheet today.

Usage
-----
    pip install pandas openpyxl
    python tools/convert_excel_to_rulebook.py materials_database.xlsx
    python tools/convert_excel_to_rulebook.py materials_database.xlsx service_life_new_tabs.xlsx

Any number of workbooks can be passed; later files win on a name clash.
The result is written to js/rulebook_data.js, which index.html already
loads. Nothing else in the app needs to change.

Worksheet names it looks for (all optional — missing ones fall back to the
built-in tables in js/rulebook.js, exactly like get_refs() does in Python):

    Component_Factors, Mix_Designs, Direct_Results, Project_Structures,
    Unit_Logic, Girder_Types,
    Strength_Classes, Carbonation_k400, Carbonation_k400_Defaults,
    Location_k1, Exposure_Classes, Chloride_CTL, Chloride_Dc,
    Binder_Mapping, Cover_Requirements, Structural_Class_Rules,
    Column_Descriptions
"""

import json
import os
import sys

import pandas as pd

# Worksheet name  ->  key used inside the app (matches _pack_database() in app.py)
SHEET_MAP = {
    "Component_Factors":         "factors",
    "Mix_Designs":               "mixes",
    "Direct_Results":            "direct",
    "Project_Structures":        "structures_raw",
    "Unit_Logic":                "unit_logic",
    "Girder_Types":              "girder_types",
    "Strength_Classes":          "strength_classes",
    "Carbonation_k400":          "carbonation_k400",
    "Carbonation_k400_Defaults": "carbonation_k400_defaults",
    "Location_k1":               "location_k1",
    "Exposure_Classes":          "exposure_classes",
    "Chloride_CTL":              "chloride_ctl",
    "Chloride_Dc":               "chloride_dc",
    "Binder_Mapping":            "binder_mapping",
    "Cover_Requirements":        "cover_requirements",
    "Structural_Class_Rules":    "structural_class_rules",
    "Column_Descriptions":       "column_descriptions",
}


def clean_df(df):
    """Strip whitespace from headers and drop fully empty rows/columns."""
    if df is None or df.empty:
        return pd.DataFrame()
    df = df.copy()
    df.columns = [str(c).strip() for c in df.columns]
    df = df.dropna(axis=0, how="all").dropna(axis=1, how="all")
    return df


def df_to_records(df):
    """DataFrame -> list of dicts, with NaN turned into None so JSON is valid."""
    if df is None or df.empty:
        return []
    out = []
    for rec in df.to_dict("records"):
        clean = {}
        for k, v in rec.items():
            if pd.isna(v):
                clean[k] = None
            elif isinstance(v, (int, float)):
                clean[k] = float(v) if isinstance(v, float) else int(v)
            else:
                clean[k] = str(v).strip()
        out.append(clean)
    return out


def build_structures(raw_records, unit_logic_records):
    """
    Project_Structures in the spreadsheet is one row per component. Option C's
    Project Builder wants them nested under their structure, so regroup here.

    Expected columns (extra ones are ignored):
        Structure, Component, Has_Concrete, Has_Rebars, Has_Strands,
        Has_Steel, Has_Bracing, Has_Bolts_Nuts, Has_Units
    """
    if not raw_records:
        return []

    flags = [("Has_Concrete", "Concrete"), ("Has_Rebars", "Rebars"),
             ("Has_Strands", "Strands"), ("Has_Steel", "Steel"),
             ("Has_Bracing", "Bracing"), ("Has_Bolts_Nuts", "Bolts_Nuts")]

    def truthy(v):
        return str(v).strip().lower() in ("1", "1.0", "y", "yes", "true", "x")

    grouped, order = {}, []
    for r in raw_records:
        s = r.get("Structure")
        c = r.get("Component")
        if not s or not c:
            continue
        if s not in grouped:
            grouped[s] = []
            order.append(s)
        rows = [label for col, label in flags if truthy(r.get(col))]
        if str(c).strip().lower() == "extra":
            rows = ["extra"]
        grouped[s].append({
            "name": str(c).strip(),
            "rows": rows,
            "units": truthy(r.get("Has_Units", "yes")) or bool(rows and rows != ["extra"]),
        })

    structures = []
    for s in order:
        comps = grouped[s]
        if not any(c["name"].lower() == "extra" for c in comps):
            comps.append({"name": "Extra", "rows": ["extra"], "units": False})
        structures.append({"Structure": s, "Components": comps})
    return structures


def build_column_help(records):
    """Column_Descriptions is a table; the app wants a plain name -> text map."""
    out = {}
    for r in records:
        name = r.get("Column_Name")
        desc = r.get("Description")
        if name and desc:
            out[str(name).strip()] = str(desc).strip()
    return out


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 1

    data = {}
    sheets_seen = []

    for path in argv[1:]:
        if not os.path.exists(path):
            print("  !  Not found, skipping: %s" % path)
            continue
        print("Reading %s" % path)
        book = pd.read_excel(path, sheet_name=None)
        for sheet_name, df in book.items():
            key = SHEET_MAP.get(str(sheet_name).strip())
            if not key:
                print("     -  %-28s (no mapping, ignored)" % sheet_name)
                continue
            records = df_to_records(clean_df(df))
            if not records:
                print("     -  %-28s (empty, ignored)" % sheet_name)
                continue
            data[key] = records
            sheets_seen.append(sheet_name)
            print("     OK %-28s %4d rows" % (sheet_name, len(records)))

    if not data:
        print("\nNothing was converted. Check the worksheet names against the list "
              "at the top of this script.")
        return 1

    # reshape the two tables whose spreadsheet form differs from the app's form
    if "structures_raw" in data:
        data["structures"] = build_structures(data.pop("structures_raw"),
                                              data.get("unit_logic", []))
    if "column_descriptions" in data:
        data["column_descriptions"] = build_column_help(data["column_descriptions"])
    if "unit_logic" in data:
        units = []
        for r in data["unit_logic"]:
            u = r.get("Unit") or r.get("Unit_String") or r.get("Unit_Name")
            if u and u not in units:
                units.append(u)
        if units:
            data["unit_options"] = units

    here = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(here, "..", "js", "rulebook_data.js")
    out_path = os.path.normpath(out_path)

    header = (
        "/* AUTO-GENERATED by tools/convert_excel_to_rulebook.py — do not edit by hand.\n"
        " * Source workbook(s): %s\n"
        " * Worksheets converted: %s\n"
        " * Re-run the converter whenever the spreadsheet changes.\n"
        " */\n\n"
        % (", ".join(os.path.basename(p) for p in argv[1:]),
           ", ".join(sheets_seen) or "none")
    )

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(header)
        f.write("var RULEBOOK_DATA = ")
        json.dump(data, f, ensure_ascii=False, indent=1)
        f.write(";\n")

    size_kb = os.path.getsize(out_path) / 1024.0
    print("\nWrote %s  (%.1f kB)" % (out_path, size_kb))
    print("Open index.html — the chip in the top right should now read")
    print("  'rulebook: Converted from the client spreadsheet (rulebook_data.js)'")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
