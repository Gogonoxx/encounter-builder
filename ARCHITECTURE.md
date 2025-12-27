# Encounter Builder - Architektur Dokumentation

**Letzte Aktualisierung:** 2024-12-23
**Version:** 0.5.1

## WICHTIG: VOR JEDER ÄNDERUNG LESEN!

Diese Dokumentation beschreibt die komplette Architektur des Encounter Builders.
**Bei Änderungen IMMER diese Datei konsultieren UND aktualisieren!**

---

## 1. SYSTEM-ÜBERSICHT

```
┌─────────────────────────────────────────────────────────────┐
│                    FOUNDRY VTT (Layer 1)                     │
│  - Input Modal (input-modal.hbs)                            │
│  - main.js: EncounterInputApp                               │
└─────────────────────────────────────────────────────────────┘
                            ↓ HTTP POST localhost:3000

┌─────────────────────────────────────────────────────────────┐
│              ENCOUNTER-SERVER.PY (Layer 2)                   │
│  - Flask HTTP Server                                        │
│  - Deterministische Auswahl + Claude API                    │
│  - Gibt JSON zurück                                         │
└─────────────────────────────────────────────────────────────┘
                            ↓ JSON Response

┌─────────────────────────────────────────────────────────────┐
│                  MAIN.JS (Layer 3)                           │
│  - Parsed JSON                                              │
│  - Wählt Output-Klasse basierend auf encounterType          │
│  - Rendert Handlebars Template                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. DATEI-STRUKTUR

```
modules/encounter-builder/
├── module.json              # Foundry Modul-Definition
├── ARCHITECTURE.md          # DIESE DATEI!
├── scripts/
│   └── main.js              # Haupt-Logik (4330+ Zeilen)
├── templates/
│   ├── input-modal.hbs      # Eingabe-Formular
│   ├── output-modal.hbs     # Generic Combat Output
│   ├── combat-output.hbs    # Combat-Spezifisch
│   ├── influence-output.hbs # Influence Encounters
│   ├── research-output.hbs  # Research Encounters
│   ├── chase-output.hbs     # Chase Encounters
│   ├── dungeon-output.hbs   # Dungeon Encounters
│   ├── infiltration-output.hbs # Infiltration Encounters
│   ├── lair-output.hbs      # Lair/Boss Encounters
│   └── travel-output.hbs    # Travel Encounters
├── styles/
│   └── encounter-builder.css # Alle Styles
└── lang/
    └── en.json              # Übersetzungen
```

**Server-Seite:**
```
tools/mcp-server/
└── encounter-server.py      # HTTP Server (10000+ Zeilen)
```

---

## 3. ENCOUNTER-TYPEN UND IHRE KLASSEN

| Encounter Type | Output-Klasse | Template | Server-Handler |
|----------------|---------------|----------|----------------|
| `combat` | `SimpleCombatOutputApp` | `combat-output.hbs` | `generate_encounter()` |
| `influence` | `InfluenceOutputApp` | `influence-output.hbs` | `generate_influence_encounter_internal()` |
| `research` | `ResearchOutputApp` | `research-output.hbs` | `generate_research_encounter_internal()` |
| `chase` | `ChaseOutputApp` | `chase-output.hbs` | `generate_chase_encounter_internal()` |
| `dungeon` | `DungeonOutputApp` | `dungeon-output.hbs` | `generate_dungeon_encounter_internal()` |
| `infiltration` | `InfiltrationOutputApp` | `infiltration-output.hbs` | `generate_infiltration_encounter_internal()` |
| `lair` | `LairOutputApp` | `lair-output.hbs` | `generate_lair_encounter_internal()` |
| `travel` | `TravelEncounterOutputApp` | `travel-output.hbs` | `generate_travel_encounter_internal()` |

---

## 4. DATA FLOW: COMBAT ENCOUNTER

### 4.1 Request (Foundry → Server)

```javascript
// main.js formHandler (Zeile 815-831)
{
  encounterType: 'combat',
  partyLevel: 9,
  partySize: 4,
  difficulty: 'severe',
  terrain: 'forest',
  includeTraits: ['humanoid', 'beast'],
  objective: 'survive',  // oder 'protect', 'ritual', etc.
  narrativeHook: 'optional context'
}
```

### 4.2 Server Processing

```
1. DETERMINISTIC (encounter-server.py)
   ├─ select_encounter_components()
   │   ├─ Wählt Danger (Front-spezifisch)
   │   ├─ Wählt Player + Hook
   │   ├─ Wählt Situation
   │   └─ Bestimmt verfügbare Monster-Kompositionen
   │
2. CLAUDE CREATIVITY
   ├─ format_simple_combat_prompt() ODER format_objective_combat_prompt()
   │   └─ Baut Prompt mit PWL-XP-Tabelle, Monster-Matrix, etc.
   │
3. TOOL USE LOOP
   ├─ Claude ruft MCP-Tools auf:
   │   ├─ get_creature(name)
   │   ├─ get_hazard(name)
   │   └─ find_creatures()
   │
4. JSON PARSING
   └─ Extrahiert {} aus Claude Response
```

### 4.3 Response (Server → Foundry)

```json
{
  "success": true,
  "encounter": {
    "name": "Titel des Encounters",
    "difficulty": "severe",
    "objective": "survive",
    "sceneDescription": "Atmosphärischer Text...",
    "monsters": [
      {
        "name": "Goblin Warrior",
        "level": 6,
        "role": "Skirmisher",
        "xp": 26,
        "count": 2
      }
    ],
    "terrain": [...],
    "hazard": {...},
    "xpBudget": {
      "total": 120,
      "breakdown": "..."
    }
  }
}
```

### 4.4 Rendering (main.js)

```javascript
// SimpleCombatOutputApp._prepareContext()
{
  title: encounter.name,
  difficulty: encounter.difficulty,
  objectiveLabel: OBJECTIVE_LABELS[encounter.objective],
  xpTotal: encounter.xpBudget?.total || 0,
  partyLevel: ...,
  partySize: ...,
  sceneHtml: formatScene(encounter.sceneDescription),
  objectiveHtml: formatObjective(encounter),
  monstersTableHtml: formatMonstersTable(encounter.monsters),
  tacticsHtml: formatTactics(encounter),
  winConditionsHtml: formatWinConditions(encounter)
}
```

### 4.5 Template (combat-output.hbs)

```handlebars
<header>
  <span class="difficulty-badge {{difficulty}}">{{difficulty}}</span>
  <span class="objective-badge">{{objectiveLabel}}</span>
  <span class="xp-badge">{{xpTotal}} XP</span>
</header>

<section class="scene-section">
  {{{sceneHtml}}}
</section>

<section class="monsters-section">
  {{{monstersTableHtml}}}
</section>
```

---

## 5. KRITISCHE ABHÄNGIGKEITEN

### Wenn du X änderst, musst du auch Y ändern:

| Änderung | Betroffene Dateien |
|----------|-------------------|
| **Neues Feld im Encounter-JSON** | 1. `encounter-server.py` (Prompt + Response) <br> 2. `main.js` (_prepareContext) <br> 3. `*.hbs` (Template Variable) <br> 4. Optional: `encounter-builder.css` |
| **Neuer Encounter-Typ** | 1. `encounter-server.py` (Handler + Router) <br> 2. `main.js` (Output-Klasse + openLastEncounter) <br> 3. `templates/` (Neues Template) <br> 4. `input-modal.hbs` (Form Fields) |
| **XP-Berechnung ändern** | 1. `encounter-server.py` (PWL_XP_TABLE) <br> 2. Prompts (format_simple_combat_prompt, etc.) |
| **Monster-Rollen ändern** | 1. `encounter-server.py` (ROLE_DESCRIPTIONS) <br> 2. Prompts (Monster Matrix) |
| **Neues Input-Feld** | 1. `input-modal.hbs` (HTML) <br> 2. `main.js` (formHandler Request-Building) <br> 3. `encounter-server.py` (EncounterRequest Model) |

---

## 6. CHECKLISTE: NEUES FELD HINZUFÜGEN

Beispiel: Du willst `escapeRoutes` zu Combat-Encounters hinzufügen.

- [ ] **encounter-server.py**:
  - [ ] Feld im Prompt beschreiben (format_simple_combat_prompt)
  - [ ] Beispiel im JSON-Output-Format zeigen
  - [ ] Falls nötig: In EncounterResponse dokumentieren

- [ ] **main.js** (SimpleCombatOutputApp):
  - [ ] In `_prepareContext()` das Feld formatieren:
    ```javascript
    escapeRoutesHtml: this._formatEscapeRoutes(encounter.escapeRoutes)
    ```
  - [ ] Formatter-Funktion schreiben:
    ```javascript
    _formatEscapeRoutes(routes) { ... }
    ```

- [ ] **combat-output.hbs**:
  - [ ] Section hinzufügen:
    ```handlebars
    {{#if escapeRoutesHtml}}
    <section class="escape-routes-section">
      {{{escapeRoutesHtml}}}
    </section>
    {{/if}}
    ```

- [ ] **encounter-builder.css** (optional):
  - [ ] Styles für `.escape-routes-section`

- [ ] **Diese Dokumentation aktualisieren!**

---

## 7. CHECKLISTE: NEUER ENCOUNTER-TYP

Beispiel: Du willst `heist` Encounters hinzufügen.

- [ ] **encounter-server.py**:
  - [ ] Neuen Handler: `generate_heist_encounter_internal()`
  - [ ] System Prompt: `HEIST_SYSTEM_PROMPT`
  - [ ] Im Router (`POST /encounter`) hinzufügen:
    ```python
    elif encounter_type == "heist":
        return await generate_heist_encounter_internal(request)
    ```
  - [ ] Response-Struktur dokumentieren

- [ ] **main.js**:
  - [ ] Neue Output-Klasse: `HeistOutputApp extends ApplicationV2`
  - [ ] In `openLastEncounter()` hinzufügen:
    ```javascript
    case 'heist':
      outputApp = new HeistOutputApp(lastEncounter);
      break;
    ```
  - [ ] `_prepareContext()` für alle Felder

- [ ] **templates/**:
  - [ ] Neues Template: `heist-output.hbs`
  - [ ] Alle Variablen aus _prepareContext verwenden

- [ ] **input-modal.hbs**:
  - [ ] Neue Form-Fields für heist-spezifische Eingaben
  - [ ] Visibility-Logic in main.js

- [ ] **Diese Dokumentation aktualisieren!**

---

## 8. XP-SYSTEM (PWL)

**KRITISCH:** Wir verwenden Proficiency Without Level (PWL).

### XP-Tabelle (NICHT ÄNDERN ohne Grund!)

| Level-Differenz | XP |
|-----------------|-----|
| PL-4 | 10 |
| PL-3 | 15 |
| PL-2 | 26 |
| PL-1 | 32 |
| PL+0 | 40 |
| PL+1 | 48 |
| PL+2 | 60 |
| PL+3 | 72 |
| PL+4 | 90 |

### XP-Budgets

| Difficulty | 4 Spieler | Pro Spieler |
|------------|-----------|-------------|
| Moderate | 80 | 20 |
| Severe | 120 | 30 |
| Extreme | 160 | 40 |

**Wo definiert:** `encounter-server.py` Zeilen 385-435 (PWL_XP_TABLE, XP_BUDGETS)

---

## 9. HTTP ENDPOINTS

| Endpoint | Methode | Beschreibung |
|----------|---------|--------------|
| `/` | GET | Health Check |
| `/health` | GET | Server Status |
| `/encounter` | POST | **Main Router** - Alle Encounter-Typen |
| `/api/generate-combat` | POST | Legacy Combat Endpoint |
| `/api/tactics` | POST | Taktik-Vorschläge |
| `/api/fronts` | GET | Alle Fronten |
| `/api/fronts/save` | POST | Fronten speichern |

---

## 10. DEBUGGING

### Server-Logs
```bash
# Server startet mit:
python encounter-server.py
# Logs erscheinen in der Konsole
```

### Foundry Console
```javascript
// Letzten Encounter anzeigen:
game.settings.get('encounter-builder', 'lastEncounter')

// Encounter-Typ prüfen:
game.settings.get('encounter-builder', 'lastEncounterType')
```

### Häufige Fehler

| Problem | Ursache | Lösung |
|---------|---------|--------|
| "0 XP" im Header | Gesamt-XP nicht im richtigen Format | Prüfe Prompt-Output-Format |
| Template zeigt nichts | Variable-Name falsch | Prüfe _prepareContext vs Template |
| Server 500 Error | JSON-Parsing fehlgeschlagen | Prüfe Claude Response-Format |

---

## 11. ÄNDERUNGSHISTORIE

| Datum | Version | Änderung |
|-------|---------|----------|
| 2024-12-23 | 0.5.1 | Dokumentation erstellt |
| | | XP-Warnungen zu Prompts hinzugefügt |
