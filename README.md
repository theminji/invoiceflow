# InvoiceFlow 💰

A complete, self-hosted invoicing SaaS you can run in one command. Built with Node.js + Express + SQLite + vanilla JS — zero build step, zero external dependencies beyond npm.

![server-js](https://img.shields.io/badge/stack-Express%20%2B%20SQLite-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Features

- **Dashboard** — live stats on totals, paid, pending, and overdue
- **Invoices** — CRUD with line items, tax, discount, overdue detection, mark-as-paid
- **Clients** — contact book reused across invoices
- **CSV export** — pull everything into Excel/Sheets
- **Polished dark-mode UI** — a clean landing page + working app in one

## Quick start

```bash
npm install
node server.js
# → http://localhost:3000
```

A demo workspace (1 user, 2 clients, 2 invoices) is seeded automatically.

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/health` | Health check |
| POST | `/api/register` | Create a workspace |
| GET | `/api/users/:id/invoices` | List invoices |
| POST | `/api/users/:id/invoices` | Create invoice |
| GET | `/api/invoices/:id` | Invoice + items + client |
| PUT | `/api/invoices/:id` | Update invoice (incl. status→paid) |
| POST | `/api/invoices/:id/items` | Add line item (auto-recalculates totals) |
| DELETE | `/api/items/:id` | Remove line item |
| GET | `/api/users/:id/clients` | List clients |
| POST | `/api/users/:id/clients` | Create client |
| DELETE | `/api/clients/:id` | Remove client |

All money math (subtotal/tax/discount/total) is recomputed server-side, never trusted from the client.

## Data

Stored in a single SQLite file (`invoiceflow.db`) created on first run. Tables: `users`, `clients`, `invoices`, `invoice_items`.

## License

MIT — use it, sell it, brand it as yours. Self-hosting makes it a $49 license for anyone who wants it off their books.

---

Built for indie hackers. If you find this useful, [sponsor the project](https://github.com/theminji).