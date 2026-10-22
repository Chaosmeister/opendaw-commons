export type Checked<T> = { readonly ok: true, readonly value: T } | { readonly ok: false, readonly error: string }

export type Issue = { readonly path: string, readonly message: string }

export type ItemDetails = Record<string, string | number | boolean>

export type ItemSummary = {
    readonly path: string
    readonly group: string
    readonly name: string
    readonly details: ItemDetails
}

export class Report {
    readonly #errors: Array<Issue> = []
    readonly #items: Array<ItemSummary> = []

    error(path: string, message: string): void {this.#errors.push({path, message})}

    item(summary: ItemSummary): void {this.#items.push(summary)}

    addDetails(path: string, details: ItemDetails): void {
        const index = this.#items.findIndex(item => item.path === path)
        if (index === -1) {return}
        const item = this.#items[index]
        this.#items[index] = {...item, details: {...item.details, ...details}}
    }

    get errors(): ReadonlyArray<Issue> {return this.#errors}
    get items(): ReadonlyArray<ItemSummary> {return this.#items}
    get ok(): boolean {return this.#errors.length === 0}

    errorsOf(path: string): ReadonlyArray<Issue> {
        return this.#errors.filter(issue => issue.path === path || issue.path.startsWith(`${path}/`))
    }
}
