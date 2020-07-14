import { CSVConverter } from "./CSVConverter";
import { JSONConverter } from "./JSONConverter";
import { XLSXConverter } from "./XLSXConverter";

export const ExportFormats = {
    XLSX: "xlsx",
    CSV: "csv",
    JSON: "json",
}

export function converterFactory(mode, columns, data, options) {
    switch (mode) {
        case ExportFormats.XLSX:
            return new XLSXConverter(columns, data, options);
        case ExportFormats.CSV:
            return new CSVConverter(columns, data, options);
        case ExportFormats.JSON:
            return new JSONConverter(columns, data, options);
    }
    throw new Error("Unknown conversion format");
}
