import * as xlsx from "xlsx";

export class XLSXConverter {
    constructor(columns, data) {
        this.columns = columns;
        this.data = data;

        this.extension = 'xlsx';
    }

    convert() {
        const data = [
            this.columns,
            ...this.data.map((row) => this.columns.map((prop) => row[prop])),
        ];
        const sheet = xlsx.utils.aoa_to_sheet(data);

        // Convert to native data types
        const dateIdx = this.columns.indexOf("date");
        if (dateIdx >= 0) {
            const column = xlsx.utils.encode_col(dateIdx);
            let i = 2;
            while (sheet[column + i]) {
                sheet[column + i].v = new Date(sheet[column + i].v);
                sheet[column + i].t = "d";
                i++;
            }
        }

        const wb = {
            SheetNames: [
                "Data",
            ],
            Sheets: {
                Data: sheet,
            },
        };
        return new Blob([xlsx.write(wb, {
            bookSST: false,
            bookType: "xlsx",
            type: "array",
        })], {
            type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
    }
}
