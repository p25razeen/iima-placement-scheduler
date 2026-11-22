# Placement Day Simulator: IIM Ahmedabad summer placements

**Live site: https://iima-placement-scheduler.netlify.app**

**Report (PDF): [report/Placement_Scheduling_Report.pdf](report/Placement_Scheduling_Report.pdf)**, with the formulations, methods, bounds, experiments and sensitivity analysis behind the simulator.

A browser-based simulator of IIM Ahmedabad summer placements, with four optimisation models for the decisions that shape the season:

| Problem | Decision | Method |
|---|---|---|
| P1 Cohort allocation | Which cohort of firms comes on which cluster day | Multiple knapsack, solved exactly by LP-based branch and bound (simplex) |
| P2 Pre-day plan | Each firm's wing, opening time, panels and rooms | Two-dimensional bin packing with one wing per role: wings by the longest-processing-time rule, bottom-left packing on morning and afternoon shelves (Little's law, release dates), improvement by savings (noon handovers) and Or-opt style moves, wing reduction; judged against relaxation lower bounds |
| P3 GD timetable | Panels, wing, start time and groups for each GD company | Multi-start insertion with an exact bipartite b-matching (augmenting paths); late GDs after 6 pm kept to a minimum and run on two panels |
| P4 Live calling | Which free panel calls which student, every minute | Assignment problem solved exactly by the Hungarian method |

Every mode (baseline = stylised current practice, optimised, manual) runs on the same synthetic students, so differences in outcome are caused by the schedule. Offer targets and dream behaviour are calibrated to the audited IPRS report for Summers 2026.

## Using it
No installation: open the live site, or open `index.html` from this folder in any modern browser. It opens with the base settings and the base run's seed (288).

| Tab | What it shows |
|---|---|
| Simulation | The building, controls (mode, speed, Play, Skip day, Reset), counters and event log; the day's plan before each cluster |
| Cohorts | Cluster of each cohort; **Solve by branch and bound** solves P1 |
| Decisions | The pre-day plan, baseline against optimised (wings, openings, panels, handovers, cost, lower bounds) |
| GD days | Both GD timetables with Gantt charts, lower bound and late GDs |
| Plan vs actual | Planned and actual windows of every firm and GD company |
| Students | Every student's calls, rounds and offers; the roster editor |
| Results | The current run, **Compare modes** and the **2×2 experiment** (planning × matching) |
| Assumptions | Every parameter, export/import of settings, sensitivity analysis |
| Firms | Every role, editable; add and remove rows; manual openings and panels |
| How it works | A short description of the model |

Edits are saved in the browser. **Restore defaults** (Assumptions), **Clear all firm edits** (Firms) and **Clear student edits** (Students) return to the base case.

## Reproducing the results in the report
The website and the command-line runner use the same engine, and a run is fixed by its seed and settings, so the numbers reproduce exactly.

- **Base-run screens:** optimised mode, seed 288, play the season.
- **Cohort allocation:** Cohorts tab, Max roles per cluster 80, Solve by branch and bound.
- **Schedules by cluster (15 runs):** Results tab, Compare modes, Runs per mode 15 (seeds 288–302).
- **2×2 experiment:** Results tab, Seeds 100, First seed 1001, Full season, Event-keyed random numbers, Run 2×2 (about 15 minutes in a browser).
- **Sensitivity:** Assumptions tab, Sensitivity analysis, 5 points, 5 runs per point (seeds 288–292).

### Command line (Node.js)
```
node tools/experiment.js --arms 2x2 --seeds 1001-1100 --rng crn --out out/main
node tools/experiment.js --arms 2x2 --seeds 1001-1030 --rng crn --checks --diag --out out/checks
node tools/experiment.js --arms 2x2 --seeds 2001-2030 --rng both --out out/pilot
```
Each writes `runs.csv`, `runs.json`, `summary.json` and `summary.md` (effects with paired 95% confidence intervals). A season takes about two seconds.

## Rules the model enforces
- **One wing per role**, in the plan and on the day; whole wings are freed when the plan's cost stays within a 2% slack.
- **Round 2:** a student who holds or has turned down an offer from a role ranked higher is dropped from the round 2 queue and never called.
- **GDs after 6 pm** are allowed but kept to a minimum, run on two panels and tagged "late buffer".

## Files
- `index.html`, `css/style.css`: page and styling
- `js/data.js`: the 234 roles with cohort, popularity, hires and interview settings
- `js/engine.js`: the simulation and the four planners
- `js/render.js`: the animated floor plan
- `js/app.js`: tabs, editors, results, comparisons and sensitivity
- `js/checks.js`, `js/stats.js`, `js/experiment.js`, `js/*-worker.js`: rule checks, statistics and batch experiments
- `tools/experiment.js`: command-line runner
- `base-settings.json`: the base settings; `netlify.toml`: hosting
- `report/Placement_Scheduling_Report.pdf`: the project report

## Deploying
Static site, no build step. On Netlify, link this repository (publish directory `.`) or drag the folder onto app.netlify.com/drop.

Students are synthetic; no personal data is used.

Group project, IIM Ahmedabad: N B Mohamed Razeen, Ananya Singh, Pratyush Saha, Shivam.
