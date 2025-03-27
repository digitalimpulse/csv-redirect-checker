# Redirect Checker & Cleaner

This Node.js script checks a CSV list of redirects for issues like redirect loops, chains, and invalid destinations. It also validates destination URLs to ensure they're reachable (HTTP 200), and outputs cleaned results and error logs.

---

## ✅ What It Does

- 🧼 Cleans duplicate redirects
- 🔁 Flags and removes redirect loops (e.g. `/ → /`)
- 🔗 Detects redirect chains (e.g. A → B → C)
- 🌐 Optionally validates destination URLs (2s delay per URL)
- 📝 Exports:
  - `output/<filename>.csv` – cleaned list with issues removed (no headers)
  - `output/redirect-errors.csv` – any destination not returning HTTP 200

---

## 🚀 How to Use

### 1. Install Node.js
Make sure you have [Node.js](https://nodejs.org) installed on your machine.

### 2. Install Dependencies
This script uses built-in Node modules, so **no installation required** — ready to run out of the box!

### 3. Prepare Your CSV
Ensure your CSV follows this format (no header row):

```
/about-us,/contact
/old-page,/new-page
```

Each line must have:
- Column 1 = source path
- Column 2 = destination URL or path

### 4. Run the Script

In your terminal, run:

```bash
node redirect-checker.js
```

You'll be prompted to enter the path to your CSV (e.g., `example.csv`).

---
