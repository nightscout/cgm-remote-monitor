export class CSVConverter {
    constructor(columns, data, options) {
        this.columns = columns;
        this.data = data;
        this.separator = ',';
        this.extension = 'csv';
        if (options.semicolonSeparated) {
            this.separator = ";";
        }
    }

    convert() {
        // MS Excel needs to be hinted at the used separator, since it uses a separator from
        // the system Regional settings
        let result = "SEP=" + this.separator + "\r\n";
        result += this.columns.map((val) => "\"" + val + "\"").join(this.separator) + "\r\n";
        result += this.data.map((row) => {
            return this.columns.map((property) => "\"" + (property === 'date' ? row[property].toISOString() : row[property]) + "\"").join(this.separator);
        }).join("\r\n");
        result += "\r\n";

        return new Blob([result], { type: "text/csv" });
    }
}
