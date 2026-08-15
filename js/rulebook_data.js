/* =====================================================================
 * rulebook_data.js
 * ---------------------------------------------------------------------
 * This file is OVERWRITTEN by tools/convert_excel_to_rulebook.py.
 *
 * Until you run the converter it stays null, and the app uses the
 * built-in tables in rulebook.js — which are the same fallback tables
 * Options A and B use when a worksheet is missing. Once you run the
 * converter against the client's real materials_database.xlsx, this
 * file holds their data and quietly takes priority.
 * ===================================================================== */

var RULEBOOK_DATA = null;
