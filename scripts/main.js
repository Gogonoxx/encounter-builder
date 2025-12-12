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

  // Hidden setting to persist the last generated encounter
  game.settings.register(MODULE_ID, 'lastEncounter', {
    name: 'Last Encounter',
    scope: 'client',
    config: false,
    type: Object,
    default: null
  });

  // Hidden setting to persist the encounter type (combat, influence, research)
  game.settings.register(MODULE_ID, 'lastEncounterType', {
    name: 'Last Encounter Type',
    scope: 'client',
    config: false,
    type: String,
    default: 'combat'
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
    generate: generateEncounter,
    openLast: openLastEncounter
  };

  if (game.user.isGM) {
    ui.notifications.info('Encounter Builder loaded. Use the scene control button or type: EncounterBuilder.open()');
  }
});

/**
 * Open the last generated encounter (if any)
 */
function openLastEncounter() {
  const lastEncounter = game.settings.get(MODULE_ID, 'lastEncounter');
  const lastType = game.settings.get(MODULE_ID, 'lastEncounterType');

  if (!lastEncounter) {
    ui.notifications.warn('No saved encounter found. Generate one first!');
    return null;
  }

  console.log('Encounter Builder | Opening last encounter:', lastEncounter.name);

  // Close existing output window if open
  if (outputApp) {
    outputApp.close();
  }

  // Create the appropriate output app based on type
  if (lastType === 'influence') {
    outputApp = new InfluenceOutputApp(lastEncounter);
  } else if (lastType === 'research') {
    outputApp = new ResearchOutputApp(lastEncounter);
  } else if (lastType === 'chase') {
    outputApp = new ChaseOutputApp(lastEncounter);
  } else if (lastType === 'dungeon') {
    outputApp = new DungeonOutputApp(lastEncounter);
  } else {
    outputApp = new EncounterOutputApp(lastEncounter, lastType);
  }

  outputApp.render(true);
  return outputApp;
}

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
// Input Application (ApplicationV2 + HandlebarsApplicationMixin)
// ============================================================================

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class EncounterInputApp extends HandlebarsApplicationMixin(ApplicationV2) {
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
      width: 580,
      height: 700
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

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Add event listener for encounter type radio buttons
    const form = this.element;
    const encounterTypeRadios = form.querySelectorAll('input[name="encounterType"]');
    const combatFields = form.querySelectorAll('.combat-only');
    const influenceFields = form.querySelectorAll('.influence-only');
    const researchFields = form.querySelectorAll('.research-only');
    const chaseFields = form.querySelectorAll('.chase-only');
    const dungeonFields = form.querySelectorAll('.dungeon-only');

    // DEBUG: Log field counts
    console.log('Encounter Builder | _onRender DEBUG:', {
      combatFields: combatFields.length,
      influenceFields: influenceFields.length,
      researchFields: researchFields.length,
      chaseFields: chaseFields.length,
      dungeonFields: dungeonFields.length
    });

    const updateFieldVisibility = (type) => {
      console.log('Encounter Builder | updateFieldVisibility called with type:', type);
      combatFields.forEach(el => {
        el.style.display = type === 'combat' ? '' : 'none';
      });
      influenceFields.forEach(el => {
        el.style.display = type === 'influence' ? '' : 'none';
      });
      researchFields.forEach(el => {
        el.style.display = type === 'research' ? '' : 'none';
      });
      chaseFields.forEach(el => {
        el.style.display = type === 'chase' ? '' : 'none';
      });
      dungeonFields.forEach(el => {
        el.style.display = type === 'dungeon' ? '' : 'none';
        if (type === 'dungeon') {
          console.log('Encounter Builder | Showing dungeon field:', el);
        }
      });
    };

    encounterTypeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        updateFieldVisibility(e.target.value);
      });
    });

    // Initialize visibility based on current selection
    const selectedType = form.querySelector('input[name="encounterType"]:checked')?.value || 'combat';
    updateFieldVisibility(selectedType);
  }

  static async formHandler(event, form, formData) {
    const data = foundry.utils.expandObject(formData.object);
    const encounterType = data.encounterType || 'combat';

    // Validate influence-specific fields
    if (encounterType === 'influence') {
      if (!data.influencePrompt?.trim()) {
        ui.notifications.error('NPC & Ziel ist erforderlich für Influence Encounters');
        return;
      }

      const request = {
        encounterType: 'influence',
        partyLevel: parseInt(data.partyLevel) || 1,
        influencePrompt: data.influencePrompt.trim()
      };

      // Show loading state
      ui.notifications.info('Generating influence encounter...');

      try {
        const encounter = await generateEncounter(request);

        // Close input modal
        if (inputApp) {
          inputApp.close();
          inputApp = null;
        }

        // Open influence output modal
        outputApp = new InfluenceOutputApp(encounter);
        outputApp.render(true);

      } catch (error) {
        console.error('Encounter Builder | Influence generation failed:', error);
        ui.notifications.error(`Failed to generate influence encounter: ${error.message}`);
      }
      return;
    }

    // Validate research-specific fields
    if (encounterType === 'research') {
      if (!data.researchPrompt?.trim()) {
        ui.notifications.error('Ort & Kontext ist erforderlich für Research Encounters');
        return;
      }

      const request = {
        encounterType: 'research',
        partyLevel: parseInt(data.partyLevel) || 1,
        researchPrompt: data.researchPrompt.trim(),
        narrativeHook: data.narrativeHook || null
      };

      // Show loading state
      ui.notifications.info('Generating research encounter...');

      try {
        const encounter = await generateEncounter(request);

        // Close input modal
        if (inputApp) {
          inputApp.close();
          inputApp = null;
        }

        // Open research output modal
        outputApp = new ResearchOutputApp(encounter);
        outputApp.render(true);

      } catch (error) {
        console.error('Encounter Builder | Research generation failed:', error);
        ui.notifications.error(`Failed to generate research encounter: ${error.message}`);
      }
      return;
    }

    // Chase encounter
    if (encounterType === 'chase') {
      if (!data.chaseContext?.trim()) {
        ui.notifications.error('Kontext ist erforderlich für Chase Encounters');
        return;
      }

      const request = {
        encounterType: 'chase',
        partyLevel: parseInt(data.partyLevel) || 1,
        chaseType: data.chaseType || 'run_away',
        chaseLength: parseInt(data.chaseLength) || 8,
        chaseTerrain: data.chaseTerrain || 'wilderness',
        chaseContext: data.chaseContext.trim(),
        narrativeHook: data.narrativeHook || null
      };

      // Show loading state
      ui.notifications.info('Generating chase encounter...');

      try {
        const encounter = await generateEncounter(request);

        // Close input modal
        if (inputApp) {
          inputApp.close();
          inputApp = null;
        }

        // Open chase output modal
        outputApp = new ChaseOutputApp(encounter);
        outputApp.render(true);

      } catch (error) {
        console.error('Encounter Builder | Chase generation failed:', error);
        ui.notifications.error(`Failed to generate chase encounter: ${error.message}`);
      }
      return;
    }

    // Dungeon encounter
    if (encounterType === 'dungeon') {
      if (!data.dungeonContext?.trim()) {
        ui.notifications.error('Kontext ist erforderlich für Dungeon Encounters');
        return;
      }

      const request = {
        encounterType: 'dungeon',
        partyLevel: parseInt(data.partyLevel) || 1,
        dungeonSize: parseInt(data.dungeonSize) || 5,
        dungeonTheme: data.dungeonTheme || 'ruins',
        dungeonThreat: data.dungeonThreat || 'undead',
        dungeonBoss: data.dungeonBoss === 'on' || data.dungeonBoss === true,
        dungeonContext: data.dungeonContext.trim(),
        narrativeHook: data.narrativeHook || null
      };

      // Show loading state
      ui.notifications.info('Generating dungeon...');

      try {
        const encounter = await generateEncounter(request);

        // Close input modal
        if (inputApp) {
          inputApp.close();
          inputApp = null;
        }

        // Open dungeon output modal
        outputApp = new DungeonOutputApp(encounter);
        outputApp.render(true);

      } catch (error) {
        console.error('Encounter Builder | Dungeon generation failed:', error);
        ui.notifications.error(`Failed to generate dungeon: ${error.message}`);
      }
      return;
    }

    // Combat encounter (default)
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
      encounterType: data.encounterType || 'combat',
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
// Output Application (ApplicationV2 + HandlebarsApplicationMixin)
// ============================================================================

class EncounterOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter, encounterType = 'combat') {
    super();
    this.encounter = encounter;
    this.encounterType = encounterType;

    // Persist the encounter
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', encounterType);
      console.log('Encounter Builder | Encounter saved to settings');
    }
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
      width: 800,
      height: 850
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
      sceneDescriptionHtml: this._formatSceneDescription(),
      situationHtml: this._formatSituation(),
      playerHookHtml: this._formatPlayerHook(),
      anchorHtml: this._formatNarrativeAnchor(),
      monstersHtml: this._formatMonsters(),
      battlefieldHtml: this._formatBattlefield(),
      hazardHtml: this._formatHazard(),
      narrativeHtml: this._formatNarrative(),
      winConditionsHtml: this._formatWinConditions()
    };
  }

  _formatSceneDescription() {
    const desc = this.encounter.sceneDescription;
    if (!desc) return '<p class="scene-placeholder"><em>Keine Szenenbeschreibung generiert.</em></p>';

    return `<div class="scene-description-block"><p class="read-aloud">${desc}</p></div>`;
  }

  _formatSituation() {
    const s = this.encounter.situation;
    if (!s) return '';

    return `
      <div class="situation-block">
        <span class="situation-badge">${s.name || s.key || 'Unbekannt'}</span>
      </div>
    `;
  }

  _formatPlayerHook() {
    const ph = this.encounter.playerHook;
    if (!ph) return '<p>Kein Spieler-Hook definiert.</p>';

    let html = '<div class="player-hook-block">';
    html += `<p><strong>🎯 Spieler:</strong> ${ph.player}</p>`;
    html += `<p><strong>📌 Hook:</strong> ${ph.hook}</p>`;
    if (ph.physicalEvidence) {
      html += `<p><strong>🔍 Im Encounter:</strong> ${ph.physicalEvidence}</p>`;
    }
    if (ph.emotionalImpact) {
      html += `<p><strong>💔 Emotion/Entscheidung:</strong> ${ph.emotionalImpact}</p>`;
    }
    html += '</div>';
    return html;
  }

  _formatNarrativeAnchor() {
    const anchor = this.encounter.narrativeAnchor || this.encounter.frontReference;
    if (!anchor) return '<p>No narrative anchor.</p>';

    let html = '<div class="front-block">';

    // Front name (supports old: sourceName/frontName, new: front)
    const front = anchor.front || anchor.sourceName || anchor.frontName;
    if (front) {
      html += `<p><strong>Front:</strong> ${front}</p>`;
    }

    // Danger name (supports old: dangerOrElement/dangerName, new: danger)
    const danger = anchor.danger || anchor.dangerOrElement || anchor.dangerName;
    if (danger) {
      html += `<p><strong>Danger:</strong> ${danger}</p>`;
    }

    // Secret (supports old: secretOrDetail/secretDescription, new: secret)
    const secret = anchor.secret || anchor.secretOrDetail || anchor.secretDescription;
    if (anchor.secretLevel) {
      html += `<p><strong>Secret (${anchor.secretLevel} XP):</strong> ${secret}</p>`;
    } else if (secret) {
      html += `<p><strong>Secret:</strong> ${secret}</p>`;
    }

    html += '</div>';
    return html;
  }

  _formatMonsters() {
    if (!this.encounter.monsters?.length) return '<p>No monsters specified.</p>';

    let html = '<table class="monster-table"><thead><tr><th>Name</th><th>Level</th><th>Role</th><th>Count</th><th>XP</th></tr></thead><tbody>';
    for (const m of this.encounter.monsters) {
      // Support both old (xp) and new (xpTotal/xpEach) format
      const xp = m.xpTotal || m.xp || (m.xpEach ? `${m.xpEach} each` : '?');

      // Name: Show "Eigenname (Monster)" if personality exists, otherwise just monster name
      let displayName = m.name;
      if (m.personality?.individualName) {
        // Extract just the first word of individualName
        const eigenname = m.personality.individualName.split(' ')[0];
        displayName = `${eigenname} (${m.name})`;
      }

      html += `<tr><td><strong>${displayName}</strong></td><td>${m.level}</td><td>${m.role}</td><td>${m.count || 1}</td><td>${xp}</td></tr>`;

      // Add key abilities if present
      if (m.keyAbilities?.length) {
        html += `<tr><td colspan="5" class="monster-abilities"><strong>Abilities:</strong> ${m.keyAbilities.join(', ')}</td></tr>`;
      }
      // Add behavior if present
      if (m.behavior) {
        html += `<tr><td colspan="5" class="monster-behavior"><em>${m.behavior}</em></td></tr>`;
      }
      // Add personality if present (distinctiveFeature + motivation)
      if (m.personality) {
        const parts = [];
        if (m.personality.distinctiveFeature) parts.push(m.personality.distinctiveFeature);
        if (m.personality.motivation) parts.push(`Motivation: ${m.personality.motivation}`);
        if (parts.length > 0) {
          html += `<tr><td colspan="5" class="monster-personality">🎭 ${parts.join(' | ')}</td></tr>`;
        }
      }
      // Add dialog if present
      if (m.dialog) {
        html += `<tr><td colspan="5" class="monster-dialog">💬 <em>"${m.dialog}"</em></td></tr>`;
      }
    }
    html += '</tbody></table>';
    return html;
  }

  _formatBattlefield() {
    // Support both old format (terrain) and new format (battlefield)
    const battlefield = this.encounter.battlefield;
    const terrain = this.encounter.terrain;

    if (battlefield) {
      let html = '';
      if (battlefield.elements?.length) {
        html += '<ul class="terrain-list">';
        for (const el of battlefield.elements) {
          html += `<li><strong>${el.name}</strong>`;
          if (el.location) html += ` <em>(${el.location})</em>`;
          html += `: ${el.why || ''}`;
          // Support both old (effect) and new (mechanicalEffect) format
          const effect = el.mechanicalEffect || el.effect;
          if (effect) html += `<br><strong>Effect:</strong> ${effect}`;
          if (el.creativeUse) html += `<br><span class="creative-use">💡 ${el.creativeUse}</span>`;
          html += '</li>';
        }
        html += '</ul>';
      }
      return html || '<p>No battlefield specified.</p>';
    }

    // Fallback to old terrain format
    if (!terrain?.length) return '<p>No terrain specified.</p>';

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

    // Header with complex badge
    let html = '<div class="hazard-block">';
    html += `<h4>${h.name} (Level ${h.level || '?'}, ${h.xp || '?'} XP)`;
    if (h.isComplex) {
      html += ' <span class="complex-badge">Komplex</span>';
    }
    html += '</h4>';

    // Trigger and Disable (always important)
    if (h.trigger) html += `<p><strong>Auslöser:</strong> ${h.trigger}</p>`;
    if (h.disable) html += `<p><strong>Entschärfen:</strong> ${h.disable}</p>`;

    // Routine (for complex hazards)
    if (h.routine && h.routine.length > 0) {
      html += '<div class="hazard-routine">';
      html += '<strong>Ablauf:</strong>';
      html += '<ol class="routine-list">';
      h.routine.forEach((step, idx) => {
        html += `<li><strong>Runde ${idx + 1}:</strong> ${step}</li>`;
      });
      html += '</ol>';
      html += '</div>';
    }

    // Reset (optional)
    if (h.reset) {
      html += `<p><strong>Reset:</strong> ${h.reset}</p>`;
    }

    // Fallback for old format (effect field)
    if (!h.routine && h.effect) {
      html += `<p><strong>Effekt:</strong> ${h.effect}</p>`;
    }

    html += '</div>';
    return html;
  }

  _formatNarrative() {
    const n = this.encounter.narrative;
    if (!n) return '<p>No narrative specified.</p>';

    let html = '<div class="narrative-block">';
    if (n.whyHere) html += `<p><strong>Why here?</strong> ${n.whyHere}</p>`;
    if (n.goal) html += `<p><strong>Goal:</strong> ${n.goal}</p>`;
    if (n.connection) html += `<p><strong>Campaign connection:</strong> ${n.connection}</p>`;
    if (n.revelation) html += `<p><strong>Revelation:</strong> ${n.revelation}</p>`;
    if (n.aftermath) html += `<p><strong>Aftermath:</strong> ${n.aftermath}</p>`;
    // NEW: Story Progression
    if (n.storyProgression) {
      html += `<p class="story-progression"><strong>📈 Story-Progression:</strong> ${n.storyProgression}</p>`;
    }
    html += '</div>';
    return html;
  }

  _formatWinConditions() {
    const wc = this.encounter.winConditions;
    if (!wc) return '<p>Defeat all enemies.</p>';

    // Handle new detailed object format
    if (typeof wc === 'object' && !Array.isArray(wc)) {
      let html = '<div class="win-conditions-block">';

      // Primary win condition (now an object with goal & method)
      if (wc.primary) {
        if (typeof wc.primary === 'object') {
          html += '<div class="primary-win-condition">';
          html += `<p><strong>🎯 Hauptziel:</strong> ${wc.primary.goal || 'Besiege alle Feinde'}</p>`;
          if (wc.primary.method) {
            html += `<p class="win-method"><em>${wc.primary.method}</em></p>`;
          }
          html += '</div>';
        } else {
          // Backwards compatibility: primary as string
          html += `<p><strong>🎯 Hauptziel:</strong> ${wc.primary}</p>`;
        }
      }

      // Creative alternatives (now detailed objects with type)
      if (wc.alternatives?.length) {
        html += '<div class="win-alternatives">';
        html += '<h4>💡 Kreative Alternativen</h4>';
        const typeIcons = {
          rettung: '🛡️',
          sabotage: '💣',
          enthauptung: '⚔️',
          flucht: '🏃',
          terrain: '🗺️'
        };
        for (const alt of wc.alternatives) {
          if (typeof alt === 'object') {
            const icon = typeIcons[alt.type] || '💡';
            html += '<div class="win-alternative">';
            html += `<p class="alt-name"><strong>${icon} ${alt.name}</strong>${alt.type ? ` <span class="alt-type">[${alt.type}]</span>` : ''}</p>`;
            if (alt.requirements) html += `<p class="alt-requirements">🔧 ${alt.requirements}</p>`;
            if (alt.outcome) html += `<p class="alt-outcome">✅ ${alt.outcome}</p>`;
            html += '</div>';
          } else {
            // Backwards compatibility: alternative as string
            html += `<p>• ${alt}</p>`;
          }
        }
        html += '</div>';
      }

      // Timer (new structured array format)
      if (wc.timer?.length) {
        html += '<div class="win-timer">';
        html += '<h4>⏱️ Timer-Eskalation</h4>';
        html += '<ul class="timer-list">';
        for (const t of wc.timer) {
          html += `<li class="timer-entry"><strong>Runde ${t.round}:</strong> ${t.effect}`;
          if (t.mechanicalImpact) {
            html += `<br><em class="mechanical-impact">→ ${t.mechanicalImpact}</em>`;
          }
          html += '</li>';
        }
        html += '</ul>';
        html += '</div>';
      } else if (wc.timerEscalation) {
        // Backwards compatibility: timerEscalation as string
        html += `<div class="win-timer"><p><strong>⏱️ Eskalation:</strong> ${wc.timerEscalation}</p></div>`;
      }

      // Escape Options (new!)
      if (wc.escapeOptions) {
        html += '<div class="escape-options">';
        html += '<h4>🚪 Fluchtoptionen</h4>';

        if (wc.escapeOptions.monsters) {
          const m = wc.escapeOptions.monsters;
          html += '<div class="escape-monsters">';
          html += '<p><strong>Monster:</strong></p>';
          if (m.trigger) html += `<p>🎯 Trigger: ${m.trigger}</p>`;
          if (m.behavior) html += `<p>🏃 Verhalten: ${m.behavior}</p>`;
          if (m.pursuit) html += `<p>⚡ Verfolgung: ${m.pursuit}</p>`;
          html += '</div>';
        }

        if (wc.escapeOptions.players) {
          const p = wc.escapeOptions.players;
          html += '<div class="escape-players">';
          html += '<p><strong>Spieler:</strong></p>';
          if (p.route) html += `<p>🚪 Route: ${p.route}</p>`;
          if (p.consequence) html += `<p>⚠️ Konsequenz: ${p.consequence}</p>`;
          html += '</div>';
        }

        html += '</div>';
      }

      html += '</div>';
      return html;
    }

    // Handle old array format
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
// Influence Output Application
// ============================================================================

class InfluenceOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;
  }

  static DEFAULT_OPTIONS = {
    id: 'influence-builder-output',
    classes: ['encounter-builder', 'influence-output'],
    window: {
      title: 'Influence Encounter',
      icon: 'fas fa-comments',
      resizable: true
    },
    position: {
      width: 700,
      height: 750
    },
    actions: {
      saveJournal: InfluenceOutputApp.saveAsJournal,
      regenerate: InfluenceOutputApp.regenerate
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/influence-output.hbs`
    }
  };

  async _prepareContext() {
    return {
      encounter: this.encounter,
      npcHtml: this._formatNpc(),
      goalHtml: this._formatGoal(),
      discoveryHtml: this._formatDiscovery(),
      influenceSkillsHtml: this._formatInfluenceSkills(),
      thresholdsHtml: this._formatThresholds(),
      resistancesHtml: this._formatResistances(),
      weaknessesHtml: this._formatWeaknesses(),
      penaltiesHtml: this._formatPenalties(),
      roundsHtml: this._formatRounds(),
      failureHtml: this._formatFailure()
    };
  }

  _formatNpc() {
    const npc = this.encounter.npc;
    if (!npc) return '';
    return `<h1 class="npc-name">${npc.name} <span class="npc-level">(Level ${npc.level || '?'})</span></h1>`;
  }

  _formatGoal() {
    const goal = this.encounter.goal;
    if (!goal) return '';
    return `<p class="influence-goal">${goal}</p>`;
  }

  _formatDiscovery() {
    const d = this.encounter.discovery;
    if (!d) return '';

    let html = '<table class="discovery-table"><thead><tr><th>Skill</th><th>DC</th></tr></thead><tbody>';

    if (d.perception) {
      html += `<tr><td>Perception</td><td>${d.perception.dc}</td></tr>`;
    }

    if (d.skills) {
      d.skills.forEach(s => {
        html += `<tr><td>${s.skill}</td><td>${s.dc}</td></tr>`;
      });
    }

    html += '</tbody></table>';
    return html;
  }

  _formatInfluenceSkills() {
    const skills = this.encounter.influenceSkills;
    if (!skills || skills.length === 0) return '';

    let html = '<table class="influence-skills-table"><thead><tr><th>Skill</th><th>DC</th><th>Notes</th></tr></thead><tbody>';

    skills.forEach(s => {
      const noteClass = s.note?.toLowerCase().includes('weakness') ? 'weakness-note' :
                       s.note?.toLowerCase().includes('resistance') ? 'resistance-note' : '';
      html += `<tr class="${noteClass}">
        <td>${s.skill}</td>
        <td>${s.dc}</td>
        <td>${s.note || '-'}</td>
      </tr>`;
    });

    html += '</tbody></table>';
    return html;
  }

  _formatThresholds() {
    const thresholds = this.encounter.thresholds;
    if (!thresholds || thresholds.length === 0) return '';

    let html = '<ul class="thresholds-list">';

    thresholds.forEach(t => {
      html += `<li><strong>${t.points} Punkte:</strong> ${t.result}</li>`;
    });

    html += '</ul>';
    return html;
  }

  _formatResistances() {
    const resistances = this.encounter.resistances;
    if (!resistances || resistances.length === 0) return '<p class="empty">-</p>';

    let html = '<ul class="resistances-list">';

    resistances.forEach(r => {
      if (typeof r === 'string') {
        html += `<li>${r}</li>`;
      } else {
        html += `<li><strong>${r.trigger}:</strong> ${r.effect}</li>`;
      }
    });

    html += '</ul>';
    return html;
  }

  _formatWeaknesses() {
    const weaknesses = this.encounter.weaknesses;
    if (!weaknesses || weaknesses.length === 0) return '<p class="empty">-</p>';

    let html = '<ul class="weaknesses-list">';

    weaknesses.forEach(w => {
      if (typeof w === 'string') {
        html += `<li>${w}</li>`;
      } else {
        html += `<li><strong>${w.trigger}:</strong> ${w.effect}</li>`;
      }
    });

    html += '</ul>';
    return html;
  }

  _formatPenalties() {
    const penalties = this.encounter.penalties;
    if (!penalties || penalties.length === 0) return '<p class="empty">Keine Penalties</p>';

    let html = '<ul class="penalties-list">';

    penalties.forEach(p => {
      if (typeof p === 'string') {
        html += `<li>${p}</li>`;
      } else {
        html += `<li><strong>${p.trigger}:</strong> ${p.effect}</li>`;
      }
    });

    html += '</ul>';
    return html;
  }

  _formatRounds() {
    const rounds = this.encounter.rounds || 3;
    const roundLength = this.encounter.roundLength || '15 Minuten';
    return `<p><strong>${rounds} Runden</strong> (à ${roundLength})</p>`;
  }

  _formatFailure() {
    const failure = this.encounter.failure;
    if (!failure) return '';
    return `<p class="failure-text">${failure}</p>`;
  }

  static async saveAsJournal() {
    const encounter = this.encounter;

    let content = `<h1>${encounter.npc?.name || 'Influence Encounter'}</h1>`;
    content += `<p><strong>Level:</strong> ${encounter.npc?.level || '?'}</p>`;
    content += `<h2>Ziel</h2><p>${encounter.goal || '-'}</p>`;

    // Discovery
    content += '<h2>Discovery</h2>';
    if (encounter.discovery) {
      content += '<ul>';
      if (encounter.discovery.perception) {
        content += `<li>Perception: DC ${encounter.discovery.perception.dc}</li>`;
      }
      encounter.discovery.skills?.forEach(s => {
        content += `<li>${s.skill}: DC ${s.dc}</li>`;
      });
      content += '</ul>';
    }

    // Influence Skills
    content += '<h2>Influence Skills</h2><table><thead><tr><th>Skill</th><th>DC</th><th>Notes</th></tr></thead><tbody>';
    encounter.influenceSkills?.forEach(s => {
      content += `<tr><td>${s.skill}</td><td>${s.dc}</td><td>${s.note || '-'}</td></tr>`;
    });
    content += '</tbody></table>';

    // Thresholds
    content += '<h2>Thresholds</h2><ul>';
    encounter.thresholds?.forEach(t => {
      content += `<li><strong>${t.points} Punkte:</strong> ${t.result}</li>`;
    });
    content += '</ul>';

    // Resistances & Weaknesses
    content += '<h2>Resistances</h2><ul>';
    encounter.resistances?.forEach(r => {
      if (typeof r === 'string') {
        content += `<li>${r}</li>`;
      } else {
        content += `<li><strong>${r.trigger}:</strong> ${r.effect}</li>`;
      }
    });
    content += '</ul>';

    content += '<h2>Weaknesses</h2><ul>';
    encounter.weaknesses?.forEach(w => {
      if (typeof w === 'string') {
        content += `<li>${w}</li>`;
      } else {
        content += `<li><strong>${w.trigger}:</strong> ${w.effect}</li>`;
      }
    });
    content += '</ul>';

    // Rounds & Failure
    content += `<h2>Zeitrahmen</h2><p>${encounter.rounds || 3} Runden (à ${encounter.roundLength || '15 Minuten'})</p>`;
    content += `<h2>Bei Misserfolg</h2><p>${encounter.failure || '-'}</p>`;

    const journal = await JournalEntry.create({
      name: `Influence: ${encounter.npc?.name || 'Unknown NPC'}`,
      pages: [{
        name: encounter.npc?.name || 'Influence Encounter',
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
// Research Output Modal
// ============================================================================

class ResearchOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;
  }

  static DEFAULT_OPTIONS = {
    id: 'research-builder-output',
    classes: ['encounter-builder', 'research-output'],
    window: {
      title: 'Research Encounter',
      icon: 'fas fa-book-dead',
      resizable: true
    },
    position: {
      width: 750,
      height: 850
    },
    actions: {
      saveJournal: ResearchOutputApp.saveAsJournal,
      regenerate: ResearchOutputApp.regenerate
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/research-output.hbs`
    }
  };

  async _prepareContext() {
    return {
      encounter: this.encounter,
      titleHtml: this._formatTitle(),
      locationHtml: this._formatLocation(),
      atmosphereHtml: this._formatAtmosphere(),
      totalRp: this.encounter.totalRp || 21,
      roundLength: this.encounter.roundLength || '1 Stunde',
      sourcesHtml: this._formatSources(),
      thresholdsHtml: this._formatThresholds(),
      complicationsHtml: this._formatComplications()
    };
  }

  _formatTitle() {
    const title = this.encounter.title;
    const front = this.encounter.front;
    if (!title) return '';
    let html = `<h1 class="research-title">${title}</h1>`;
    if (front) {
      html += `<p class="research-front"><i class="fas fa-flag"></i> ${front}</p>`;
    }
    return html;
  }

  _formatLocation() {
    const location = this.encounter.location;
    if (!location) return '';
    return `<p class="research-location">${location}</p>`;
  }

  _formatAtmosphere() {
    const atmosphere = this.encounter.atmosphere;
    if (!atmosphere) return '';
    return `<p class="research-atmosphere">${atmosphere}</p>`;
  }

  _formatSources() {
    const sources = this.encounter.sources;
    if (!sources || sources.length === 0) return '';

    let html = '<div class="sources-grid">';

    sources.forEach(source => {
      html += `<div class="source-card">
        <div class="source-header">
          <h3 class="source-name">${source.name}</h3>
          <span class="source-max-rp">${source.maxRp} RP</span>
        </div>
        <p class="source-description">${source.description}</p>
        <table class="source-skills">
          <thead><tr><th>Skill</th><th>DC</th><th>Ansatz</th><th>Methode</th></tr></thead>
          <tbody>`;

      if (source.skills) {
        source.skills.forEach(skill => {
          // Determine approach class and label
          const approach = skill.approach || 'standard';
          const approachLabels = {
            easy: { label: 'Gut', class: 'approach-easy', icon: '✓' },
            standard: { label: 'Normal', class: 'approach-standard', icon: '−' },
            hard: { label: 'Schwer', class: 'approach-hard', icon: '✗' }
          };
          const approachInfo = approachLabels[approach] || approachLabels.standard;

          html += `<tr class="${approachInfo.class}">
            <td class="skill-name">${skill.skill}</td>
            <td class="skill-dc">${skill.dc}</td>
            <td class="skill-approach"><span class="approach-badge ${approachInfo.class}">${approachInfo.icon} ${approachInfo.label}</span></td>
            <td class="skill-method">${skill.method || '-'}</td>
          </tr>`;
        });
      }

      html += `</tbody></table></div>`;
    });

    html += '</div>';
    return html;
  }

  _formatThresholds() {
    const thresholds = this.encounter.thresholds;
    if (!thresholds || thresholds.length === 0) return '';

    let html = '<table class="thresholds-table"><thead><tr><th>RP</th><th>XP</th><th>Secret</th></tr></thead><tbody>';

    thresholds.forEach(t => {
      const xpClass = t.xp === 50 ? 'xp-legendary' : t.xp === 30 ? 'xp-major' : 'xp-minor';
      html += `<tr class="${xpClass}">
        <td class="rp-value">${t.rp}</td>
        <td class="xp-value">${t.xp} XP</td>
        <td class="secret-text">${t.secret}</td>
      </tr>`;
    });

    html += '</tbody></table>';
    return html;
  }

  _formatComplications() {
    const complications = this.encounter.complications;
    if (!complications || complications.length === 0) return '<p class="empty">Keine Komplikationen</p>';

    let html = '<ul class="complications-list">';

    complications.forEach(c => {
      html += `<li>
        <span class="complication-trigger">Bei ${c.atRp} RP:</span>
        <span class="complication-event">${c.event}</span>
      </li>`;
    });

    html += '</ul>';
    return html;
  }

  static async saveAsJournal() {
    const encounter = outputApp?.encounter;
    if (!encounter) return;

    const title = encounter.title || 'Research Encounter';

    // Build markdown content
    let content = `# ${title}\n\n`;

    if (encounter.front) {
      content += `**Front:** ${encounter.front}\n\n`;
    }

    if (encounter.location) {
      content += `## Ort\n${encounter.location}\n\n`;
    }

    if (encounter.atmosphere) {
      content += `## Atmosphäre\n${encounter.atmosphere}\n\n`;
    }

    content += `## Research-Mechanik\n`;
    content += `- **Gesamt-RP:** ${encounter.totalRp || 21}\n`;
    content += `- **Rundenlänge:** ${encounter.roundLength || '1 Stunde'}\n\n`;
    content += `| Ergebnis | RP |\n|---|---|\n`;
    content += `| Critical Success | +2 |\n| Success | +1 |\n| Failure | -1 |\n| Critical Failure | -2 |\n\n`;

    if (encounter.sources?.length > 0) {
      content += `## Fantastische Quellen\n\n`;
      encounter.sources.forEach(s => {
        content += `### ${s.name} (${s.maxRp} RP)\n`;
        content += `${s.description}\n\n`;
        content += `| Skill | DC | Methode |\n|---|---|---|\n`;
        s.skills?.forEach(skill => {
          content += `| ${skill.skill} | ${skill.dc} | ${skill.method || '-'} |\n`;
        });
        content += '\n';
      });
    }

    if (encounter.thresholds?.length > 0) {
      content += `## Schwellenwerte\n\n`;
      content += `| RP | XP | Secret |\n|---|---|---|\n`;
      encounter.thresholds.forEach(t => {
        content += `| ${t.rp} | ${t.xp} | ${t.secret} |\n`;
      });
      content += '\n';
    }

    if (encounter.complications?.length > 0) {
      content += `## Komplikationen\n\n`;
      encounter.complications.forEach(c => {
        content += `- **Bei ${c.atRp} RP:** ${c.event}\n`;
      });
    }

    // Create journal entry
    const journal = await JournalEntry.create({
      name: title,
      pages: [{
        name: title,
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
// Chase Output Application
// ============================================================================

class ChaseOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;

    // DEBUG: Log full encounter structure
    console.log('Encounter Builder | Chase encounter received:', JSON.stringify(encounter, null, 2));
    console.log('Encounter Builder | obstacles:', encounter?.obstacles);
    console.log('Encounter Builder | obstacles type:', typeof encounter?.obstacles);
    console.log('Encounter Builder | obstacles length:', encounter?.obstacles?.length);

    // Persist the encounter
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'chase');
      console.log('Encounter Builder | Chase encounter saved to settings');
    }
  }

  static DEFAULT_OPTIONS = {
    id: 'chase-builder-output',
    classes: ['encounter-builder', 'chase-output'],
    window: {
      title: 'Chase Encounter',
      icon: 'fas fa-running',
      resizable: true
    },
    position: {
      width: 800,
      height: 900
    },
    actions: {
      saveJournal: ChaseOutputApp.saveAsJournal,
      regenerate: ChaseOutputApp.regenerate
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/chase-output.hbs`
    }
  };

  async _prepareContext() {
    return {
      encounter: this.encounter,
      titleHtml: this._formatTitle(),
      scenarioHtml: this._formatScenario(),
      startPositionHtml: this._formatStartPosition(),
      obstaclesHtml: this._formatObstacles(),
      endConditionsHtml: this._formatEndConditions(),
      complicationHtml: this._formatComplication(),
      chasePointsRulesHtml: this._formatChasePointsRules()
    };
  }

  _formatTitle() {
    const name = this.encounter.name || 'Chase Encounter';
    const chaseType = this.encounter.chaseType;
    const obstaclesArray = this.encounter.obstacles || this.encounter.hindernisse || [];
    const length = this.encounter.length || obstaclesArray.length || '?';

    const typeLabels = {
      run_away: '🏃 Flucht',
      chase_down: '🎯 Verfolgung',
      beat_clock: '⏱️ Wettlauf',
      competitive: '🏁 Konkurrenz'
    };

    const typeLabel = typeLabels[chaseType] || chaseType || '';

    let html = `<h1 class="chase-title">${name}</h1>`;
    html += `<div class="chase-meta">`;
    if (typeLabel) html += `<span class="chase-type-badge">${typeLabel}</span>`;
    html += `<span class="chase-length">${length} Hindernisse</span>`;
    html += `</div>`;
    return html;
  }

  _formatScenario() {
    const scenario = this.encounter.scenario;
    if (!scenario) return '';
    return `<p class="chase-scenario">${scenario}</p>`;
  }

  _formatStartPosition() {
    const startPosition = this.encounter.startPosition;
    if (!startPosition) return '';
    return `<p class="chase-start-position"><i class="fas fa-flag-checkered"></i> <strong>Startposition:</strong> ${startPosition}</p>`;
  }

  _formatObstacles() {
    // Try multiple possible keys (in case Claude uses German)
    const obstacles = this.encounter.obstacles || this.encounter.hindernisse || this.encounter.Obstacles || [];
    console.log('Encounter Builder | _formatObstacles called, obstacles:', obstacles);
    if (!obstacles || obstacles.length === 0) return '<p>Keine Hindernisse generiert. Prüfe die Konsole für Debug-Ausgaben.</p>';

    let html = '<div class="obstacles-grid">';

    obstacles.forEach((obs, idx) => {
      html += `<div class="obstacle-card">
        <div class="obstacle-header">
          <span class="obstacle-number">${obs.number || idx + 1}</span>
          <h3 class="obstacle-name">${obs.name}</h3>
          <span class="obstacle-cp">${obs.chasePoints || 3} CP</span>
        </div>`;

      if (obs.description) {
        html += `<p class="obstacle-description">${obs.description}</p>`;
      }

      if (obs.options && obs.options.length > 0) {
        html += '<table class="obstacle-options"><thead><tr><th>Skill</th><th>DC</th><th>Methode</th></tr></thead><tbody>';
        obs.options.forEach(opt => {
          html += `<tr>
            <td class="skill-name">${opt.skill}</td>
            <td class="skill-dc">${opt.dc}</td>
            <td class="skill-method">${opt.method || '-'}</td>
          </tr>`;
        });
        html += '</tbody></table>';
      }

      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  _formatEndConditions() {
    const endConditions = this.encounter.endConditions;
    if (!endConditions) return '';

    let html = '<div class="end-conditions">';

    if (endConditions.success) {
      html += `<div class="end-condition success">
        <h4><i class="fas fa-trophy"></i> Bei Erfolg</h4>
        <p>${endConditions.success}</p>
      </div>`;
    }

    if (endConditions.failure) {
      html += `<div class="end-condition failure">
        <h4><i class="fas fa-skull-crossbones"></i> Bei Misserfolg</h4>
        <p>${endConditions.failure}</p>
      </div>`;
    }

    html += '</div>';
    return html;
  }

  _formatComplication() {
    const complication = this.encounter.complication;
    if (!complication) return '';
    return `<div class="chase-complication">
      <h4><i class="fas fa-exclamation-triangle"></i> Komplikation</h4>
      <p>${complication}</p>
    </div>`;
  }

  _formatChasePointsRules() {
    return `<div class="chase-rules-summary">
      <h4><i class="fas fa-info-circle"></i> Chase Points Regeln</h4>
      <table class="cp-rules-table">
        <tr><td>Critical Success</td><td class="cp-value">+2 CP</td></tr>
        <tr><td>Success</td><td class="cp-value">+1 CP</td></tr>
        <tr><td>Failure</td><td class="cp-value">+0 CP</td></tr>
        <tr><td>Critical Failure</td><td class="cp-value">-1 CP</td></tr>
      </table>
      <p class="cp-note">Hindernisse haben jeweils eine CP-Schwelle (meist 3). Sammle genug CP um das Hindernis zu überwinden.</p>
    </div>`;
  }

  static async saveAsJournal() {
    const encounter = outputApp?.encounter;
    if (!encounter) return;

    const title = encounter.name || 'Chase Encounter';

    // Build markdown content
    let content = `# ${title}\n\n`;

    // Chase type
    const typeLabels = {
      run_away: 'Flucht',
      chase_down: 'Verfolgung',
      beat_clock: 'Wettlauf gegen die Zeit',
      competitive: 'Konkurrenz'
    };
    const typeLabel = typeLabels[encounter.chaseType] || encounter.chaseType;
    if (typeLabel) {
      content += `**Typ:** ${typeLabel}\n\n`;
    }

    // Scenario
    if (encounter.scenario) {
      content += `## Szenario\n${encounter.scenario}\n\n`;
    }

    // Start position
    if (encounter.startPosition) {
      content += `**Startposition:** ${encounter.startPosition}\n\n`;
    }

    // Chase Points Rules
    content += `## Chase Points Regeln\n`;
    content += `| Ergebnis | CP |\n|---|---|\n`;
    content += `| Critical Success | +2 |\n| Success | +1 |\n| Failure | +0 |\n| Critical Failure | -1 |\n\n`;

    // Obstacles
    if (encounter.obstacles?.length > 0) {
      content += `## Hindernisse\n\n`;
      encounter.obstacles.forEach((obs, idx) => {
        content += `### ${obs.number || idx + 1}. ${obs.name} (${obs.chasePoints || 3} CP)\n`;
        if (obs.description) content += `${obs.description}\n\n`;
        content += `| Skill | DC | Methode |\n|---|---|---|\n`;
        obs.options?.forEach(opt => {
          content += `| ${opt.skill} | ${opt.dc} | ${opt.method || '-'} |\n`;
        });
        content += '\n';
      });
    }

    // End conditions
    if (encounter.endConditions) {
      content += `## Endbedingungen\n\n`;
      if (encounter.endConditions.success) {
        content += `**Bei Erfolg:** ${encounter.endConditions.success}\n\n`;
      }
      if (encounter.endConditions.failure) {
        content += `**Bei Misserfolg:** ${encounter.endConditions.failure}\n\n`;
      }
    }

    // Complication
    if (encounter.complication) {
      content += `## Komplikation\n${encounter.complication}\n`;
    }

    // Create journal entry
    const journal = await JournalEntry.create({
      name: title,
      pages: [{
        name: title,
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
// Dungeon Output Application
// ============================================================================

class DungeonOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;

    // Persist the encounter
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'dungeon');
      console.log('Encounter Builder | Dungeon encounter saved to settings');
    }
  }

  static DEFAULT_OPTIONS = {
    id: 'dungeon-builder-output',
    classes: ['encounter-builder', 'dungeon-output'],
    window: {
      title: 'Dungeon',
      icon: 'fas fa-dungeon',
      resizable: true
    },
    position: {
      width: 900,
      height: 950
    },
    actions: {
      saveJournal: DungeonOutputApp.saveAsJournal,
      regenerate: DungeonOutputApp.regenerate,
      copyPrompt: DungeonOutputApp.copyPrompt
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/dungeon-output.hbs`
    }
  };

  async _prepareContext() {
    return {
      encounter: this.encounter,
      titleHtml: this._formatTitle(),
      conceptHtml: this._formatConcept(),
      zonesHtml: this._formatZones(),
      roomsHtml: this._formatRooms(),
      secretsHtml: this._formatSecrets(),
      loreHtml: this._formatLore(),
      bossHtml: this._formatBoss(),
      summaryHtml: this._formatSummary()
    };
  }

  _formatTitle() {
    const name = this.encounter.name || 'Dungeon';
    const theme = this.encounter.theme;
    const roomCount = this.encounter.rooms?.length || '?';

    const themeLabels = {
      ruins: '🏛️ Ruinen',
      cave: '🕳️ Höhle',
      temple: '⛪ Tempel',
      fortress: '🏰 Festung',
      crypt: '⚰️ Krypta',
      laboratory: '🧪 Labor',
      mine: '⛏️ Mine',
      sewers: '🚰 Kanalisation'
    };

    const themeLabel = themeLabels[theme] || theme || '';

    let html = `<h1 class="dungeon-title">${name}</h1>`;
    html += `<div class="dungeon-meta">`;
    if (themeLabel) html += `<span class="dungeon-theme-badge">${themeLabel}</span>`;
    html += `<span class="dungeon-room-count">${roomCount} Räume</span>`;
    html += `</div>`;
    return html;
  }

  _formatConcept() {
    const concept = this.encounter.concept;
    if (!concept) return '';
    return `<p class="dungeon-concept">${concept}</p>`;
  }

  _formatZones() {
    const zones = this.encounter.zones;
    if (!zones || zones.length === 0) return '';

    let html = '<div class="zones-grid">';

    zones.forEach(zone => {
      html += `<div class="zone-card">
        <h4 class="zone-name">${zone.name}</h4>
        <p class="zone-purpose">${zone.purpose || ''}</p>
        ${zone.atmosphere ? `<p class="zone-atmosphere"><em>${zone.atmosphere}</em></p>` : ''}
      </div>`;
    });

    html += '</div>';
    return html;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Generate the node map after rendering
    this._generateNodeMap();
  }

  _generateNodeMap() {
    const svg = this.element.querySelector('#dungeon-node-map');
    if (!svg || !this.encounter.rooms) return;

    const rooms = this.encounter.rooms;
    const nodeRadius = 25;
    const width = 800;
    const height = 250;

    // Set SVG dimensions
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', height);

    // Calculate node positions using a simple force-directed-like layout
    const positions = this._calculateNodePositions(rooms, width, height, nodeRadius);

    // Room type colors
    const typeColors = {
      entry: '#4a90d9',      // Blue
      combat: '#d9534f',     // Red
      lore: '#9b59b6',       // Purple
      transition: '#95a5a6', // Gray
      puzzle: '#f39c12',     // Orange
      trap: '#e74c3c',       // Dark Red
      rest: '#27ae60',       // Green
      treasure: '#f1c40f',   // Gold
      boss: '#8b0000'        // Dark Red
    };

    const typeIcons = {
      entry: '🚪',
      combat: '⚔️',
      lore: '📜',
      transition: '🚶',
      puzzle: '🧩',
      trap: '⚠️',
      rest: '🏕️',
      treasure: '💎',
      boss: '👑'
    };

    // Draw connections first (so they appear behind nodes)
    rooms.forEach((room, idx) => {
      const roomNum = room.number || idx + 1;
      const fromPos = positions[roomNum];
      if (!fromPos || !room.connections) return;

      room.connections.forEach(targetNum => {
        // Handle both string and number connections
        const targetId = typeof targetNum === 'string' ? parseInt(targetNum.replace(/\D/g, '')) : targetNum;
        const toPos = positions[targetId];
        if (!toPos) return;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', fromPos.x);
        line.setAttribute('y1', fromPos.y);
        line.setAttribute('x2', toPos.x);
        line.setAttribute('y2', toPos.y);
        line.setAttribute('stroke', '#5d6d7e');
        line.setAttribute('stroke-width', '3');
        line.setAttribute('stroke-linecap', 'round');
        svg.appendChild(line);
      });
    });

    // Draw nodes
    rooms.forEach((room, idx) => {
      const roomNum = room.number || idx + 1;
      const pos = positions[roomNum];
      if (!pos) return;

      const roomType = room.roomType || (room.isBoss ? 'boss' : 'combat');
      const color = typeColors[roomType] || typeColors.combat;

      // Node group
      const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.setAttribute('class', `map-node map-node-${roomType}`);
      group.setAttribute('data-room', roomNum);
      group.style.cursor = 'pointer';

      // Circle
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', pos.x);
      circle.setAttribute('cy', pos.y);
      circle.setAttribute('r', nodeRadius);
      circle.setAttribute('fill', color);
      circle.setAttribute('stroke', '#2c3e50');
      circle.setAttribute('stroke-width', '3');
      group.appendChild(circle);

      // Room number text
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', pos.x);
      text.setAttribute('y', pos.y + 5);
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'white');
      text.setAttribute('font-weight', 'bold');
      text.setAttribute('font-size', '14');
      text.textContent = roomNum;
      group.appendChild(text);

      // Type icon above node
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      icon.setAttribute('x', pos.x);
      icon.setAttribute('y', pos.y - nodeRadius - 5);
      icon.setAttribute('text-anchor', 'middle');
      icon.setAttribute('font-size', '16');
      icon.textContent = typeIcons[roomType] || '❓';
      group.appendChild(icon);

      // Click handler to scroll to room
      group.addEventListener('click', () => {
        const roomCard = this.element.querySelector(`.room-card[data-room="${roomNum}"]`);
        if (roomCard) {
          roomCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          roomCard.classList.add('highlight');
          setTimeout(() => roomCard.classList.remove('highlight'), 2000);
        }
      });

      svg.appendChild(group);
    });
  }

  _calculateNodePositions(rooms, width, height, radius) {
    const positions = {};
    const padding = radius + 40;
    const usableWidth = width - padding * 2;
    const usableHeight = height - padding * 2;

    // Simple grid-like layout based on room number
    const numRooms = rooms.length;
    const cols = Math.ceil(Math.sqrt(numRooms * 2));
    const rows = Math.ceil(numRooms / cols);

    rooms.forEach((room, idx) => {
      const roomNum = room.number || idx + 1;
      const col = idx % cols;
      const row = Math.floor(idx / cols);

      // Add some offset for visual interest
      const offsetX = (row % 2) * (usableWidth / cols / 2);

      positions[roomNum] = {
        x: padding + (col * usableWidth / (cols - 1 || 1)) + offsetX * 0.3,
        y: padding + (row * usableHeight / (rows - 1 || 1))
      };
    });

    return positions;
  }

  _formatRooms() {
    const rooms = this.encounter.rooms;
    if (!rooms || rooms.length === 0) return '<p>Keine Räume generiert.</p>';

    // Room type icons and labels
    const typeInfo = {
      entry: { icon: '🚪', label: 'Eingang', class: 'room-entry' },
      combat: { icon: '⚔️', label: 'Kampf', class: 'room-combat' },
      lore: { icon: '📜', label: 'Lore', class: 'room-lore' },
      transition: { icon: '🚶', label: 'Übergang', class: 'room-transition' },
      puzzle: { icon: '🧩', label: 'Rätsel', class: 'room-puzzle' },
      trap: { icon: '⚠️', label: 'Falle', class: 'room-trap' },
      rest: { icon: '🏕️', label: 'Rastplatz', class: 'room-rest' },
      treasure: { icon: '💎', label: 'Schatz', class: 'room-treasure' },
      boss: { icon: '👑', label: 'Boss', class: 'room-boss' }
    };

    let html = '<div class="rooms-list">';

    rooms.forEach((room, idx) => {
      const roomNum = room.number || idx + 1;
      const roomType = room.roomType || (room.isBoss ? 'boss' : 'combat');
      const isBoss = room.isBoss || roomType === 'boss';
      const info = typeInfo[roomType] || typeInfo.combat;

      html += `<div class="room-card ${isBoss ? 'boss-room' : ''} ${info.class}" data-room="${roomNum}">
        <div class="room-header">
          <span class="room-number">${roomNum}</span>
          <h3 class="room-name">${room.name}</h3>
          <span class="room-type-badge ${info.class}">${info.icon} ${info.label}</span>
        </div>`;

      if (room.description) {
        html += `<p class="room-description">${room.description}</p>`;
      }

      // Connections (node-graph) - format nicely
      if (room.connections && room.connections.length > 0) {
        const connectionStr = room.connections.map(c => `Raum ${c}`).join(', ');
        html += `<p class="room-connections"><i class="fas fa-door-open"></i> <strong>Verbindungen:</strong> ${connectionStr}</p>`;
      }

      // Lore Content (for lore rooms)
      if (room.loreContent) {
        html += `<div class="room-lore-content">
          <strong><i class="fas fa-book"></i> Entdeckung:</strong>
          <p>${room.loreContent}</p>
        </div>`;
      }

      // Transition Note (for transition rooms)
      if (room.transitionNote) {
        html += `<div class="room-transition-note">
          <em><i class="fas fa-wind"></i> ${room.transitionNote}</em>
        </div>`;
      }

      // Terrain elements
      if (room.terrain && room.terrain.length > 0) {
        html += '<div class="room-terrain"><strong>Terrain:</strong><ul>';
        room.terrain.forEach(t => {
          html += `<li>${t}</li>`;
        });
        html += '</ul></div>';
      }

      // Combat Prompt (copyable) - only for combat-type rooms
      if (room.combatPrompt) {
        const promptId = `combat-prompt-${roomNum}`;
        html += `<div class="combat-prompt-container">
          <div class="combat-prompt-header">
            <strong><i class="fas fa-swords"></i> Combat-Prompt</strong>
            <button type="button" class="copy-prompt-btn" data-action="copyPrompt" data-prompt-id="${promptId}">
              <i class="fas fa-copy"></i> Kopieren
            </button>
          </div>
          <pre class="combat-prompt" id="${promptId}">${room.combatPrompt}</pre>
        </div>`;
      }

      // Secret (if room has one)
      if (room.secret) {
        html += `<div class="room-secret">
          <strong><i class="fas fa-search"></i> Geheimnis (DC ${room.secret.dc || '?'}):</strong>
          <p>${room.secret.description || room.secret}</p>
        </div>`;
      }

      html += '</div>';
    });

    html += '</div>';
    return html;
  }

  _formatSecrets() {
    const secrets = this.encounter.secrets;
    if (!secrets || secrets.length === 0) return '';

    let html = '<ul class="secrets-list">';

    secrets.forEach(secret => {
      html += `<li class="secret-item">
        <span class="secret-dc">DC ${secret.dc || '?'}</span>
        <span class="secret-description">${secret.description || secret}</span>
      </li>`;
    });

    html += '</ul>';
    return html;
  }

  _formatLore() {
    const lore = this.encounter.lore;
    if (!lore || lore.length === 0) return '';

    let html = '<ul class="lore-list">';

    lore.forEach(l => {
      html += `<li class="lore-item">${l}</li>`;
    });

    html += '</ul>';
    return html;
  }

  _formatBoss() {
    const boss = this.encounter.bossRoom;
    if (!boss) return '';

    let html = '<div class="boss-section">';

    if (boss.name) {
      html += `<h4 class="boss-name"><i class="fas fa-crown"></i> ${boss.name}</h4>`;
    }

    if (boss.description) {
      html += `<p class="boss-description">${boss.description}</p>`;
    }

    // Boss Combat Prompt (copyable)
    if (boss.combatPrompt) {
      html += `<div class="combat-prompt-container">
        <div class="combat-prompt-header">
          <strong><i class="fas fa-swords"></i> Boss Combat-Prompt</strong>
          <button type="button" class="copy-prompt-btn" data-action="copyPrompt" data-prompt-id="boss-combat-prompt">
            <i class="fas fa-copy"></i> Kopieren
          </button>
        </div>
        <pre class="combat-prompt" id="boss-combat-prompt">${boss.combatPrompt}</pre>
      </div>`;
    }

    html += '</div>';
    return html;
  }

  _formatSummary() {
    const summary = this.encounter.summary;
    if (!summary) return '';
    return `<p class="dungeon-summary">${summary}</p>`;
  }

  static async copyPrompt(event, target) {
    const promptId = target.dataset.promptId;
    const promptEl = document.getElementById(promptId);
    if (!promptEl) return;

    const text = promptEl.textContent;

    try {
      await navigator.clipboard.writeText(text);
      ui.notifications.info('Combat-Prompt in Zwischenablage kopiert!');

      // Visual feedback
      const originalText = target.innerHTML;
      target.innerHTML = '<i class="fas fa-check"></i> Kopiert!';
      setTimeout(() => {
        target.innerHTML = originalText;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
      ui.notifications.error('Kopieren fehlgeschlagen');
    }
  }

  static async saveAsJournal() {
    const encounter = outputApp?.encounter;
    if (!encounter) return;

    const title = encounter.name || 'Dungeon';

    // Build markdown content
    let content = `# ${title}\n\n`;

    // Theme
    if (encounter.theme) {
      content += `**Setting:** ${encounter.theme}\n\n`;
    }

    // Concept
    if (encounter.concept) {
      content += `## Konzept\n${encounter.concept}\n\n`;
    }

    // Zones
    if (encounter.zones?.length > 0) {
      content += `## Zonen\n\n`;
      encounter.zones.forEach(zone => {
        content += `### ${zone.name}\n`;
        if (zone.purpose) content += `${zone.purpose}\n`;
        if (zone.atmosphere) content += `*${zone.atmosphere}*\n`;
        content += '\n';
      });
    }

    // Rooms
    if (encounter.rooms?.length > 0) {
      content += `## Räume\n\n`;
      encounter.rooms.forEach((room, idx) => {
        const roomNum = room.number || idx + 1;
        const isBoss = room.isBoss || room.type === 'boss';
        content += `### ${roomNum}. ${room.name}${isBoss ? ' 👑 Boss' : ''}\n`;
        if (room.description) content += `${room.description}\n\n`;

        if (room.connections?.length > 0) {
          content += `**Verbindungen:** ${room.connections.join(', ')}\n\n`;
        }

        if (room.terrain?.length > 0) {
          content += `**Terrain:**\n`;
          room.terrain.forEach(t => {
            content += `- ${t}\n`;
          });
          content += '\n';
        }

        if (room.combatPrompt) {
          content += `**Combat-Prompt:**\n\`\`\`\n${room.combatPrompt}\n\`\`\`\n\n`;
        }

        if (room.secret) {
          const secretDesc = room.secret.description || room.secret;
          content += `**Geheimnis (DC ${room.secret.dc || '?'}):** ${secretDesc}\n\n`;
        }
      });
    }

    // Secrets
    if (encounter.secrets?.length > 0) {
      content += `## Geheimnisse\n\n`;
      encounter.secrets.forEach(secret => {
        const desc = secret.description || secret;
        content += `- **DC ${secret.dc || '?'}:** ${desc}\n`;
      });
      content += '\n';
    }

    // Lore
    if (encounter.lore?.length > 0) {
      content += `## Lore\n\n`;
      encounter.lore.forEach(l => {
        content += `- ${l}\n`;
      });
      content += '\n';
    }

    // Boss Room
    if (encounter.bossRoom) {
      content += `## Boss-Raum\n\n`;
      if (encounter.bossRoom.name) content += `### ${encounter.bossRoom.name}\n`;
      if (encounter.bossRoom.description) content += `${encounter.bossRoom.description}\n\n`;
      if (encounter.bossRoom.combatPrompt) {
        content += `**Combat-Prompt:**\n\`\`\`\n${encounter.bossRoom.combatPrompt}\n\`\`\`\n\n`;
      }
    }

    // Summary
    if (encounter.summary) {
      content += `## Zusammenfassung\n${encounter.summary}\n`;
    }

    // Create journal entry
    const journal = await JournalEntry.create({
      name: title,
      pages: [{
        name: title,
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

  // Create AbortController with 5-minute timeout for complex encounter generation
  // (Server needs ~9 iterations × 20-30s per API call = 3-4.5 minutes)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 300000); // 5 minutes

  try {
    const response = await fetch(`${serverUrl}/encounter`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(request),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Server error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Unknown error');
    }

    return data.encounter;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error('Request timed out after 5 minutes. The server may be overloaded.');
    }
    throw error;
  }
}
