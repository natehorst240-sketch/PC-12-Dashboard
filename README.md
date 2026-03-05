# Pilatus PC-12 Fleet Maintenance Dashboard
**SINGLE ENGINE TURBOPROP**

Live dashboard: https://USERNAME.github.io/pc12-dashboard/

## Setup

### 1. Repository structure
```
pc12-dashboard/
├── data/
│   ├── PC12-Daily-Due-List.csv          ← drop daily export here
│   ├── PC12-Long-Range.csv     ← drop weekly export here
│   └── pilatus_pc_12_flight_hours_history.json  ← auto-generated
├── public/
│   └── index.html
├── src/
│   └── build_dashboard.py
└── .github/workflows/build.yml
```

### 2. GitHub Actions permissions
Settings → Actions → General → Workflow permissions → Read and write

### 3. GitHub Pages
Settings → Pages → Source: GitHub Actions

### 4. Windows Task Scheduler
Set up a task to copy your Veryon daily export to `data/PC12-Daily-Due-List.csv` and run:
```
python src/build_dashboard.py
git add .
git commit -m "Daily update"
git push
```

## Inspections Tracked
- **600 HOUR OR 12 MONTHS INSPECTION** — ATA match: `05 404A AAIP` (hours)
- **1200 HOUR OR 12 MONTHS INSPECTION** — ATA match: `05 405A AAIP` (hours)
- **300 HOUR OR 12 MONTHS INSPECTION** — ATA match: `05 402A AAIP` (hours)
- **2400 HOUR OR 24 MONTHS INSPECTION** — ATA match: `05 406A AAIP` (hours)
- **ENGINE - 1750 - 2000 HOUR HOT SECTION INSPECTION** — ATA match: `71 0021` (hours)

## Bar Chart
**Hours Remaining — 300 HOUR OR 12 MONTHS INSPECTION** (hours remaining)
