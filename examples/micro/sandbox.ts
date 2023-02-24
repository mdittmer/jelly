'use strict';

class X {
    data: string;

    constructor(data: string) {
        this.data = data;
    }

    getData(): string {
        return this.data;
    }
}

const x = new X('data');
console.log(x.getData());
