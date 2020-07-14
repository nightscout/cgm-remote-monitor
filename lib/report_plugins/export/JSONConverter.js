export class JSONConverter {
    constructor(columns, data) {
        this.columns = columns;
        this.data = data;

        this.extension = 'json';
    }

    convert() {
        const data = JSON.stringify(this.data);

        return new Blob([data], { type: "application/json" });
    }
}
