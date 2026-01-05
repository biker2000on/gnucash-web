# GnuCash Web PWA

A modern, read-only Progressive Web App (PWA) for GnuCash, built with Next.js and powered by a PostgreSQL database. It provides a sleek, dark-themed interface to view your financial accounts and transaction history on any device.

## ✨ Features

- **Account Hierarchy**: Explore your GnuCash account structure with expandable/collapsible nodes.
- **Financial Metrics**: View **Total Balance** and **Annual Period Balance** (Current Year) for every account.
- **Recursive Aggregation**: Parent accounts automatically display the sum of their children's balances.
- **Transaction Journal**: A detailed list of transactions with color-coded split breakdowns and account names.
- **Infinite Scroll**: Smoothly browse through your entire transaction history with automatic background loading.
- **Hidden Account Toggle**: Easily show or hide accounts marked as `hidden` in GnuCash.
- **Progressive Web App**: Install the app on your phone or desktop for a native-like experience.
- **Docker Ready**: Includes a multi-stage Dockerfile for optimized, minified production deployments.

## 🚀 Getting Started

### Prerequisites

- [Node.js 20+](https://nodejs.org/) (Project uses Volta for version pinning)
- A PostgreSQL database with a [GnuCash schema](https://www.gnucash.org/docs/v5/mobile-man/gnc-database-architecture.html).

### Environment Variables

Create a `.env.local` file in the root directory:

```env
DATABASE_URL="postgresql://user:password@host:5432/dbname"
```

### Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to view the app.

### Production (Local)

```bash
npm run build
npm run start
```

## 🐳 Docker

The project includes a multi-stage Docker build that generates a highly optimized `standalone` bundle.

### Build and Run

```bash
# Build the image
docker build -t gnucash-web .

# Run the container
docker run -p 3000:3000 -e DATABASE_URL="your_db_url" gnucash-web
```

## 🛠️ Tech Stack

- **Framework**: [Next.js 15+](https://nextjs.org/) (App Router)
- **Styling**: [Tailwind CSS](https://tailwindcss.com/)
- **Database**: PostgreSQL (via `pg`)
- **PWA**: `next-pwa`
- **Typing**: TypeScript

## 📄 License

This project is open-source and intended for personal use with GnuCash data.
