/**
 * PF2E Encounter Builder
 * AI-powered encounter generator using a local server with Claude API
 */

// ============================================================================
// Constants
// ============================================================================

const MODULE_ID = 'encounter-builder';
const DEFAULT_SERVER_URL = 'http://localhost:3000';

// ============================================================================
// Module State
// ============================================================================

let inputApp = null;
let outputApp = null;

// ============================================================================
// Settings Registration
// ============================================================================

Hooks.once('init', () => {
  console.log('Encounter Builder | Initializing module');

  // Register module settings
  game.settings.register(MODULE_ID, 'serverUrl', {
    name: 'Server URL',
    hint: 'URL of the local encounter server (default: http://localhost:3000)',
    scope: 'world',
    config: true,
    type: String,
    default: DEFAULT_SERVER_URL
  });

  game.settings.register(MODULE_ID, 'defaultDifficulty', {
    name: 'Default Difficulty',
    hint: 'Default encounter difficulty',
    scope: 'client',
    config: true,
    type: String,
    choices: {
      'moderate': 'Moderate (80 XP)',
      'severe': 'Severe (120 XP)',
      'extreme': 'Extreme (160 XP)'
    },
    default: 'severe'
  });

  game.settings.register(MODULE_ID, 'defaultPartySize', {
    name: 'Default Party Size',
    hint: 'Default number of players',
    scope: 'client',
    config: true,
    type: Number,
    default: 4
  });
});

// ============================================================================
// Ready Hook
// ============================================================================

Hooks.once('ready', () => {
  console.log('Encounter Builder | Module ready');

  // Expose API globally
  globalThis.EncounterBuilder = {
    open: openEncounterBuilder,
    generate: generateEncounter
  };

  if (game.user.isGM) {
    ui.notifications.info('Encounter Builder loaded. Use the scene control button or type: EncounterBuilder.open()');
  }
});

// ============================================================================
// Scene Control Button (V13 API)
// ============================================================================

Hooks.on('getSceneControlButtons', (controls) => {
  const tokenControls = controls.tokens;
  if (tokenControls?.tools) {
    tokenControls.tools['encounter-builder'] = {
      name: 'encounter-builder',
      title: 'Encounter Builder',
      icon: 'fas fa-dragon',
      order: Object.keys(tokenControls.tools).length,
      button: true,
      visible: game.user.isGM,
      onChange: () => {
        openEncounterBuilder();
      }
    };
  }
});

// ============================================================================
// Open Encounter Builder
// ============================================================================

function openEncounterBuilder() {
  if (inputApp && inputApp.rendered) {
    inputApp.bringToFront();
    return;
  }

  inputApp = new EncounterInputApp();
  inputApp.render(true);
}

// ============================================================================
// Input Application (ApplicationV2)
// ============================================================================

class EncounterInputApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: 'encounter-builder-input',
    classes: ['encounter-builder'],
    tag: 'form',
    window: {
      title: 'Encounter Builder',
      icon: 'fas fa-dragon',
      resizable: true
    },
    position: {
      width: 500,
      height: 'auto'
    },
    form: {
      handler: EncounterInputApp.formHandler,
      submitOnChange: false,
      closeOnSubmit: false
    }
  };

  static PARTS = {
    form: {
      template: `modules/${MODULE_ID}/templates/input-modal.hbs`
    }
  };

  async _prepareContext() {
    // Get average party level from selected tokens or all player characters
    let partyLevel = 1;
    const selectedTokens = canvas.tokens?.controlled || [];

    if (selectedTokens.length > 0) {
      const levels = selectedTokens
        .filter(t => t.actor?.type === 'character')
        .map(t => t.actor.system?.details?.level?.value || 1);
      if (levels.length > 0) {
        partyLevel = Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
      }
    } else {
      // Use all player characters
      const pcs = game.actors.filter(a => a.type === 'character' && a.hasPlayerOwner);
      if (pcs.length > 0) {
        const levels = pcs.map(a => a.system?.details?.level?.value || 1);
        partyLevel = Math.round(levels.reduce((a, b) => a + b, 0) / levels.length);
      }
    }

    return {
      partyLevel,
      partySize: game.settings.get(MODULE_ID, 'defaultPartySize'),
      difficulty: game.settings.get(MODULE_ID, 'defaultDifficulty'),
      terrainOptions: [
        { value: '', label: '-- Any --' },
        { value: 'dungeon', label: 'Dungeon' },
        { value: 'forest', label: 'Forest' },
        { value: 'swamp', label: 'Swamp' },
        { value: 'mountain', label: 'Mountain' },
        { value: 'urban', label: 'Urban' },
        { value: 'plains', label: 'Plains' },
        { value: 'desert', label: 'Desert' },
        { value: 'underground', label: 'Underground' },
        { value: 'aquatic', label: 'Aquatic' }
      ],
      creatureTraits: [
        'aberration', 'animal', 'beast', 'construct', 'dragon', 'elemental',
        'fey', 'fiend', 'giant', 'humanoid', 'monitor', 'ooze', 'plant', 'undead'
      ]
    };
  }

  static async formHandler(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);

    // Parse traits arrays
    const includeTraits = data.includeTraits
      ? (Array.isArray(data.includeTraits) ? data.includeTraits : [data.includeTraits])
      : [];
    const excludeTraits = data.excludeTraits
      ? (Array.isArray(data.excludeTraits) ? data.excludeTraits : [data.excludeTraits])
      : [];

    const request = {
      partyLevel: parseInt(data.partyLevel) || 1,
      partySize: parseInt(data.partySize) || 4,
      difficulty: data.difficulty || 'severe',
      terrain: data.terrain || null,
      includeTraits: includeTraits.filter(t => t),
      excludeTraits: excludeTraits.filter(t => t),
      narrativeHook: data.narrativeHook || null
    };

    // Show loading state
    ui.notifications.info('Generating encounter...');

    try {
      const encounter = await generateEncounter(request);

      // Close input modal
      if (inputApp) {
        inputApp.close();
        inputApp = null;
      }

      // Open output modal
      outputApp = new EncounterOutputApp(encounter);
      outputApp.render(true);

    } catch (error) {
      console.error('Encounter Builder | Generation failed:', error);
      ui.notifications.error(`Failed to generate encounter: ${error.message}`);
    }
  }
}

// ============================================================================
// Output Application (ApplicationV2)
// ============================================================================

class EncounterOutputApp extends foundry.applications.api.ApplicationV2 {
  constructor(encounter) {
    super();
    this.encounter = encounter;
  }

  static DEFAULT_OPTIONS = {
    id: 'encounter-builder-output',
    classes: ['encounter-builder', 'encounter-output'],
    window: {
      title: 'Generated Encounter',
      icon: 'fas fa-dragon',
      resizable: true
    },
    position: {
      width: 700,
      height: 600
    },
    actions: {
      saveJournal: EncounterOutputApp.saveAsJournal,
      regenerate: EncounterOutputApp.regenerate
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/output-modal.hbs`
    }
  };

  async _prepareContext() {
    return {
      encounter: this.encounter,
      monstersHtml: this._formatMonsters(),
      terrainHtml: this._formatTerrain(),
      hazardHtml: this._formatHazard(),
      tacticsHtml: this._formatTactics(),
      narrativeHtml: this._formatNarrative(),
      winConditionsHtml: this._formatWinConditions()
    };
  }

  _formatMonsters() {
    if (!this.encounter.monsters?.length) return '<p>No monsters specified.</p>';

    let html = '<table class="monster-table"><thead><tr><th>Name</th><th>Level</th><th>Role</th><th>Count</th></tr></thead><tbody>';
    for (const m of this.encounter.monsters) {
      const uuid = m.uuid || `@UUID[Compendium.pf2e.pathfinder-bestiary.Actor.${m.name}]{${m.name}}`;
      html += `<tr><td>${uuid}</td><td>${m.level}</td><td>${m.role}</td><td>${m.count || 1}</td></tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  _formatTerrain() {
    if (!this.encounter.terrain?.length) return '<p>No terrain specified.</p>';

    let html = '<ul class="terrain-list">';
    for (const t of this.encounter.terrain) {
      html += `<li><strong>${t.type}:</strong> ${t.description}`;
      if (t.effect) html += ` <em>(${t.effect})</em>`;
      html += '</li>';
    }
    html += '</ul>';
    return html;
  }

  _formatHazard() {
    const h = this.encounter.hazard;
    if (!h) return '<p>No hazard specified.</p>';

    return `
      <div class="hazard-block">
        <h4>${h.name} (Level ${h.level}, ${h.xp} XP)</h4>
        <p>${h.description}</p>
        ${h.trigger ? `<p><strong>Trigger:</strong> ${h.trigger}</p>` : ''}
        ${h.effect ? `<p><strong>Effect:</strong> ${h.effect}</p>` : ''}
      </div>
    `;
  }

  _formatTactics() {
    const t = this.encounter.tactics;
    if (!t) return '<p>No tactics specified.</p>';

    let html = '<div class="tactics-block">';
    if (t.setup) html += `<p><strong>Setup:</strong> ${t.setup}</p>`;
    if (t.round1) html += `<p><strong>Round 1:</strong> ${t.round1}</p>`;
    if (t.general) html += `<p><strong>General:</strong> ${t.general}</p>`;
    if (t.morale) html += `<p><strong>Morale:</strong> ${t.morale}</p>`;
    html += '</div>';

    const rp = this.encounter.roleplaying;
    if (rp) {
      html += '<div class="roleplaying-block">';
      if (rp.personality) html += `<p><strong>Personality:</strong> ${rp.personality}</p>`;
      if (rp.dialogue) html += `<p><strong>Dialogue:</strong> <em>"${rp.dialogue}"</em></p>`;
      html += '</div>';
    }

    return html;
  }

  _formatNarrative() {
    const n = this.encounter.narrative;
    if (!n) return '<p>No narrative specified.</p>';

    let html = '<div class="narrative-block">';
    if (n.whyHere) html += `<p><strong>Why here?</strong> ${n.whyHere}</p>`;
    if (n.connection) html += `<p><strong>Campaign connection:</strong> ${n.connection}</p>`;
    if (n.aftermath) html += `<p><strong>Aftermath:</strong> ${n.aftermath}</p>`;
    html += '</div>';
    return html;
  }

  _formatWinConditions() {
    const wc = this.encounter.winConditions;
    if (!wc?.length) return '<p>Defeat all enemies.</p>';

    let html = '<ul class="win-conditions">';
    for (const c of wc) {
      html += `<li>${c}</li>`;
    }
    html += '</ul>';
    return html;
  }

  static async saveAsJournal() {
    const encounter = this.encounter;

    // Build journal content
    let content = `<h1>${encounter.name}</h1>`;
    content += `<p><strong>Difficulty:</strong> ${encounter.difficulty} | <strong>XP:</strong> ${encounter.xpBudget?.total || '?'}</p>`;

    content += '<h2>Monsters</h2>' + this._formatMonsters();
    content += '<h2>Terrain</h2>' + this._formatTerrain();
    content += '<h2>Hazard</h2>' + this._formatHazard();
    content += '<h2>Tactics</h2>' + this._formatTactics();
    content += '<h2>Narrative</h2>' + this._formatNarrative();
    content += '<h2>Win Conditions</h2>' + this._formatWinConditions();

    // Create journal entry
    const journal = await JournalEntry.create({
      name: `Encounter: ${encounter.name}`,
      pages: [{
        name: encounter.name,
        type: 'text',
        text: { content, format: 1 }
      }]
    });

    ui.notifications.info(`Created journal: ${journal.name}`);
    journal.sheet.render(true);
  }

  static async regenerate() {
    // Close output and reopen input
    if (outputApp) {
      outputApp.close();
      outputApp = null;
    }
    openEncounterBuilder();
  }
}

// ============================================================================
// API: Generate Encounter
// ============================================================================

async function generateEncounter(request) {
  const serverUrl = game.settings.get(MODULE_ID, 'serverUrl');

  const response = await fetch(`${serverUrl}/encounter`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    throw new Error(`Server error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || 'Unknown error');
  }

  return data.encounter;
}
