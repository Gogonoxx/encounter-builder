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
let lastTravelRequest = null;  // Store last travel request for regeneration

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

  // Hidden setting to track if output window was open (for persistence)
  game.settings.register(MODULE_ID, 'windowOpen', {
    name: 'Window Open State',
    scope: 'client',
    config: false,
    type: Boolean,
    default: false
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

  // Restore window state if it was open before reload
  if (game.user.isGM) {
    const wasOpen = game.settings.get(MODULE_ID, 'windowOpen');
    if (wasOpen) {
      console.log('Encounter Builder | Restoring window state');
      openLastEncounter();
    } else {
      ui.notifications.info('Encounter Builder loaded. Use the scene control button or type: EncounterBuilder.open()');
    }
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
  } else if (lastType === 'infiltration') {
    outputApp = new InfiltrationOutputApp(lastEncounter);
  } else if (lastType === 'lair') {
    outputApp = new LairOutputApp(lastEncounter);
  } else if (lastType === 'simple-combat') {
    // Extract requestData from the stored encounter object
    const requestData = lastEncounter.requestData || {
      partyLevel: lastEncounter.partyLevel || 1,
      partySize: lastEncounter.partySize || 4,
      difficulty: lastEncounter.difficulty || 'severe'
    };
    outputApp = new SimpleCombatOutputApp(lastEncounter, requestData);
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
  // If output window is already open, bring it to front
  if (outputApp && outputApp.rendered) {
    outputApp.bringToFront();
    return;
  }

  // If we have a saved encounter, restore it
  const lastEncounter = game.settings.get(MODULE_ID, 'lastEncounter');
  if (lastEncounter) {
    openLastEncounter();
    return;
  }

  // Otherwise open the input dialog
  openEncounterInput();
}

/**
 * Force open the input dialog (used by backToBuilder)
 */
function openEncounterInput() {
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
      width: 500,
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
    const infiltrationFields = form.querySelectorAll('.infiltration-only');
    const lairFields = form.querySelectorAll('.lair-only');
    const travelFields = form.querySelectorAll('.travel-only');

    // DEBUG: Log field counts
    console.log('Encounter Builder | _onRender DEBUG:', {
      combatFields: combatFields.length,
      influenceFields: influenceFields.length,
      researchFields: researchFields.length,
      chaseFields: chaseFields.length,
      dungeonFields: dungeonFields.length,
      infiltrationFields: infiltrationFields.length,
      lairFields: lairFields.length,
      travelFields: travelFields.length
    });

    // Track current encounter type (needs to be let, not const, so it can update)
    let currentEncounterType = form.querySelector('input[name="encounterType"]:checked')?.value || 'combat';

    // Party level field (hide for travel)
    const partyLevelGroup = form.querySelector('.party-level-group');

    const updateFieldVisibility = (type) => {
      console.log('Encounter Builder | updateFieldVisibility called with type:', type);
      currentEncounterType = type; // Update current type

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
      infiltrationFields.forEach(el => {
        el.style.display = type === 'infiltration' ? '' : 'none';
      });
      lairFields.forEach(el => {
        el.style.display = type === 'lair' ? '' : 'none';
      });
      travelFields.forEach(el => {
        el.style.display = type === 'travel' ? '' : 'none';
      });

      // Hide party level for travel encounters
      if (partyLevelGroup) {
        partyLevelGroup.style.display = type === 'travel' ? 'none' : '';
      }
    };

    // Campaign-specific section handling (fronts + players)
    const campaignSpecificCheckbox = form.querySelector('#campaignSpecific');
    const campaignPlayersSection = form.querySelector('.campaign-players-section');
    const campaignFrontsSection = form.querySelector('.campaign-fronts-section');
    const playerCheckboxes = form.querySelectorAll('input[name="activePlayers"]');
    const frontCheckboxes = form.querySelectorAll('input[name="selectedFronts"]');

    // Show/hide campaign sections based on campaignSpecific checkbox
    const updateCampaignSectionsVisibility = () => {
      const showCampaignSections = campaignSpecificCheckbox?.checked && currentEncounterType === 'travel';

      if (campaignFrontsSection) {
        campaignFrontsSection.style.display = showCampaignSections ? '' : 'none';
      }
      if (campaignPlayersSection) {
        campaignPlayersSection.style.display = showCampaignSections ? '' : 'none';
      }
      console.log('Encounter Builder | updateCampaignSectionsVisibility:', { showCampaignSections, checked: campaignSpecificCheckbox?.checked, type: currentEncounterType });
    };

    // Load saved player selection from localStorage
    const loadSavedPlayerSelection = () => {
      try {
        const saved = localStorage.getItem('encounter-builder-active-players');
        if (saved) {
          const activePlayers = JSON.parse(saved);
          playerCheckboxes.forEach(checkbox => {
            checkbox.checked = activePlayers.includes(checkbox.value);
          });
          console.log('Encounter Builder | Loaded player selection:', activePlayers);
        }
      } catch (e) {
        console.warn('Encounter Builder | Could not load player selection:', e);
      }
    };

    // Save player selection to localStorage
    const savePlayerSelection = () => {
      const activePlayers = Array.from(playerCheckboxes)
        .filter(cb => cb.checked)
        .map(cb => cb.value);
      localStorage.setItem('encounter-builder-active-players', JSON.stringify(activePlayers));
      console.log('Encounter Builder | Saved player selection:', activePlayers);
    };

    // Load saved front selection from localStorage
    const loadSavedFrontSelection = () => {
      try {
        const saved = localStorage.getItem('encounter-builder-selected-fronts');
        if (saved) {
          const selectedFronts = JSON.parse(saved);
          frontCheckboxes.forEach(checkbox => {
            checkbox.checked = selectedFronts.includes(checkbox.value);
          });
          console.log('Encounter Builder | Loaded front selection:', selectedFronts);
        }
      } catch (e) {
        console.warn('Encounter Builder | Could not load front selection:', e);
      }
    };

    // Save front selection to localStorage
    const saveFrontSelection = () => {
      const selectedFronts = Array.from(frontCheckboxes)
        .filter(cb => cb.checked)
        .map(cb => cb.value);
      localStorage.setItem('encounter-builder-selected-fronts', JSON.stringify(selectedFronts));
      console.log('Encounter Builder | Saved front selection:', selectedFronts);
    };

    // Load saved campaignSpecific state
    const loadCampaignSpecificState = () => {
      try {
        const saved = localStorage.getItem('encounter-builder-campaign-specific');
        if (saved === 'true' && campaignSpecificCheckbox) {
          campaignSpecificCheckbox.checked = true;
        }
      } catch (e) {
        console.warn('Encounter Builder | Could not load campaign-specific state:', e);
      }
    };

    // Event listener for encounterType radios
    encounterTypeRadios.forEach(radio => {
      radio.addEventListener('change', (e) => {
        updateFieldVisibility(e.target.value);
        updateCampaignSectionsVisibility();
      });
    });

    // Initialize visibility based on current selection
    updateFieldVisibility(currentEncounterType);

    // Event listener for campaignSpecific checkbox
    if (campaignSpecificCheckbox) {
      campaignSpecificCheckbox.addEventListener('change', (e) => {
        localStorage.setItem('encounter-builder-campaign-specific', e.target.checked);
        updateCampaignSectionsVisibility();
      });
    }

    // Event listeners for player checkboxes (save on change)
    playerCheckboxes.forEach(checkbox => {
      checkbox.addEventListener('change', savePlayerSelection);
    });

    // Event listeners for front checkboxes (save on change)
    frontCheckboxes.forEach(checkbox => {
      checkbox.addEventListener('change', saveFrontSelection);
    });

    // Initialize on load
    loadSavedPlayerSelection();
    loadSavedFrontSelection();
    loadCampaignSpecificState();
    updateCampaignSectionsVisibility();
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
        influencePrompt: data.influencePrompt.trim(),
        comedicRelief: data.comedicRelief || false
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
        narrativeHook: data.narrativeHook || null,
        comedicRelief: data.comedicRelief || false
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
        narrativeHook: data.narrativeHook || null,
        comedicRelief: data.comedicRelief || false
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
        narrativeHook: data.narrativeHook || null,
        comedicRelief: data.comedicRelief || false
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

    // Infiltration encounter
    if (encounterType === 'infiltration') {
      console.log('Encounter Builder | Infiltration form data:', {
        infiltrationContext: data.infiltrationContext,
        infiltrationType: data.infiltrationType,
        infiltrationComplexity: data.infiltrationComplexity,
        allKeys: Object.keys(data)
      });

      if (!data.infiltrationContext?.trim()) {
        ui.notifications.error('Ziel & Kontext ist erforderlich für Infiltration Encounters');
        return;
      }

      const request = {
        encounterType: 'infiltration',
        partyLevel: parseInt(data.partyLevel) || 1,
        infiltrationType: data.infiltrationType || 'custom',
        complexity: parseInt(data.infiltrationComplexity) || 10,
        context: data.infiltrationContext.trim(),
        narrativeHook: data.narrativeHook || null,
        comedicRelief: data.comedicRelief || false
      };

      console.log('Encounter Builder | Infiltration request:', request);

      // Show loading state
      ui.notifications.info('Generating infiltration encounter...');

      try {
        const encounter = await generateEncounter(request);

        // Close input modal
        if (inputApp) {
          inputApp.close();
          inputApp = null;
        }

        // Open infiltration output modal
        outputApp = new InfiltrationOutputApp(encounter);
        outputApp.render(true);

      } catch (error) {
        console.error('Encounter Builder | Infiltration generation failed:', error);
        ui.notifications.error(`Failed to generate infiltration encounter: ${error.message}`);
      }
      return;
    }

    // Lair encounter (Boss with Lair Actions)
    if (encounterType === 'lair') {
      console.log('Encounter Builder | Lair form data:', {
        lairContext: data.lairContext,
        lairTerrain: data.lairTerrain,
        lairDifficulty: data.lairDifficulty,
        partyLevel: data.partyLevel
      });

      if (!data.lairContext?.trim()) {
        ui.notifications.error('Kontext ist erforderlich für Lair Encounters');
        return;
      }

      const request = {
        encounterType: 'lair',
        partyLevel: parseInt(data.partyLevel) || 1,
        lairContext: data.lairContext.trim(),
        lairTerrain: data.lairTerrain || 'cave',
        lairDifficulty: parseInt(data.lairDifficulty) || 2,
        narrativeHook: data.narrativeHook || null,
        comedicRelief: data.comedicRelief || false
      };

      console.log('Encounter Builder | Lair request:', request);

      // Show loading state
      ui.notifications.info('Generating lair encounter...');

      try {
        const encounter = await generateEncounter(request);

        // Close input modal
        if (inputApp) {
          inputApp.close();
          inputApp = null;
        }

        // Open lair output modal
        outputApp = new LairOutputApp(encounter);
        outputApp.render(true);

      } catch (error) {
        console.error('Encounter Builder | Lair generation failed:', error);
        ui.notifications.error(`Failed to generate lair encounter: ${error.message}`);
      }
      return;
    }

    // Travel encounter (A Chance Meeting or A Bump in the Road)
    if (encounterType === 'travel') {
      // Get active players from checkboxes (for campaign-specific hooks)
      // Filter out null/undefined values that come from unchecked checkboxes
      const activePlayers = data.activePlayers
        ? (Array.isArray(data.activePlayers) ? data.activePlayers : [data.activePlayers]).filter(p => p != null)
        : [];

      // Get selected fronts from checkboxes (for filtering dangers/secrets)
      const selectedFronts = data.selectedFronts
        ? (Array.isArray(data.selectedFronts) ? data.selectedFronts : [data.selectedFronts]).filter(f => f != null)
        : [];

      console.log('Encounter Builder | Travel form data:', {
        travelEncounterType: data.travelEncounterType,
        travelBiome: data.travelBiome,
        travelContext: data.travelContext,
        partyLevel: data.partyLevel,
        campaignSpecific: data.campaignSpecific,
        comedicRelief: data.comedicRelief,
        activePlayers: activePlayers,
        selectedFronts: selectedFronts
      });

      const request = {
        encounterType: 'travel',
        partyLevel: parseInt(data.partyLevel) || 1,
        travelEncounterType: data.travelEncounterType || 'a_chance_meeting',
        travelBiome: data.travelBiome || 'grasslands',
        travelContext: data.travelContext?.trim() || null,
        campaignSpecific: Boolean(data.campaignSpecific),
        comedicRelief: Boolean(data.comedicRelief),
        activePlayers: activePlayers,
        selectedFronts: selectedFronts.length > 0 ? selectedFronts : null
      };

      console.log('Encounter Builder | Travel request:', request);

      // Store the request for regeneration
      lastTravelRequest = request;

      // Show loading state
      ui.notifications.info('Generating travel encounter...');

      try {
        const encounter = await generateEncounter(request);

        // Close input modal
        if (inputApp) {
          inputApp.close();
          inputApp = null;
        }

        // Open travel output modal
        outputApp = new TravelEncounterOutputApp(encounter);
        outputApp.render(true);

      } catch (error) {
        console.error('Encounter Builder | Travel generation failed:', error);
        ui.notifications.error(`Failed to generate travel encounter: ${error.message}`);
      }
      return;
    }

    // Combat encounter (default) - uses simplified combat generator
    // Parse creature types from includeTraits
    const includeTraits = data.includeTraits
      ? (Array.isArray(data.includeTraits) ? data.includeTraits : [data.includeTraits])
      : [];

    const request = {
      partyLevel: parseInt(data.partyLevel) || 1,
      partySize: parseInt(data.partySize) || 4,
      difficulty: data.difficulty || 'severe',
      creatureTypes: includeTraits.filter(t => t),
      narrativeHint: data.narrativeHook || '',
      terrain: data.terrain || ''
    };

    // Show loading state
    ui.notifications.info('Generating combat encounter...');

    try {
      const encounter = await generateSimpleCombat(request);

      // Close input modal
      if (inputApp) {
        inputApp.close();
        inputApp = null;
      }

      // Open simple combat output modal
      outputApp = new SimpleCombatOutputApp(encounter, request);
      outputApp.render(true);

    } catch (error) {
      console.error('Encounter Builder | Combat generation failed:', error);
      ui.notifications.error(`Failed to generate combat encounter: ${error.message}`);
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

    // Persist the encounter and window state
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', encounterType);
      game.settings.set(MODULE_ID, 'windowOpen', true);
      console.log('Encounter Builder | Encounter saved to settings');
    }
  }

  async close(options = {}) {
    game.settings.set(MODULE_ID, 'windowOpen', false);
    return super.close(options);
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
      regenerate: EncounterOutputApp.regenerate,
      backToBuilder: EncounterOutputApp.backToBuilder
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

      // Support BOTH formats: old (behavior/dialog) and new (tactics.opening/behavior/dialog)
      const behavior = m.behavior || m.tactics?.behavior;
      const opening = m.tactics?.opening;
      const dialog = m.dialog || m.tactics?.dialog;

      // Add opening if present (new generic format)
      if (opening) {
        html += `<tr><td colspan="5" class="monster-opening"><strong>Eröffnung:</strong> ${opening}</td></tr>`;
      }
      // Add behavior if present
      if (behavior) {
        html += `<tr><td colspan="5" class="monster-behavior"><em>${behavior}</em></td></tr>`;
      }
      // Add personality if present (distinctiveFeature + motivation) - campaign format
      if (m.personality) {
        const parts = [];
        if (m.personality.distinctiveFeature) parts.push(m.personality.distinctiveFeature);
        if (m.personality.motivation) parts.push(`Motivation: ${m.personality.motivation}`);
        if (parts.length > 0) {
          html += `<tr><td colspan="5" class="monster-personality">🎭 ${parts.join(' | ')}</td></tr>`;
        }
      }
      // Add dialog if present
      if (dialog) {
        html += `<tr><td colspan="5" class="monster-dialog">💬 <em>"${dialog}"</em></td></tr>`;
      }
    }
    html += '</tbody></table>';
    return html;
  }

  _formatBattlefield() {
    // Support multiple formats: battlefield.elements, terrain array, or terrain string
    const battlefield = this.encounter.battlefield;
    const terrain = this.encounter.terrain;

    // Format 1: Campaign format with battlefield.elements
    if (battlefield?.elements?.length) {
      let html = '<ul class="terrain-list">';
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
      return html;
    }

    // Format 2: Generic format with terrain array [{name, effect, creativeUse}]
    if (Array.isArray(terrain) && terrain.length > 0) {
      let html = '<ul class="terrain-list">';
      for (const t of terrain) {
        // Support both new generic format (name, effect, creativeUse) and old format (type, description, effect)
        const name = t.name || t.type;
        const desc = t.description || '';
        const effect = t.effect;
        const creativeUse = t.creativeUse;

        html += `<li><strong>${name}</strong>`;
        if (desc) html += `: ${desc}`;
        if (effect) html += `<br><strong>Effect:</strong> ${effect}`;
        if (creativeUse) html += `<br><span class="creative-use">💡 ${creativeUse}</span>`;
        html += '</li>';
      }
      html += '</ul>';
      return html;
    }

    return '<p>No terrain specified.</p>';
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

    // Campaign-specific fields
    if (n.connection) html += `<p><strong>Campaign connection:</strong> ${n.connection}</p>`;
    if (n.revelation) html += `<p><strong>Revelation:</strong> ${n.revelation}</p>`;
    if (n.aftermath) html += `<p><strong>Aftermath:</strong> ${n.aftermath}</p>`;
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

  static async backToBuilder() {
    // Close output and reopen input
    if (outputApp) {
      outputApp.close();
      outputApp = null;
    }
    openEncounterInput();
  }
}

// ============================================================================
// Influence Output Application
// ============================================================================

class InfluenceOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;

    // Persist the encounter and window state
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'influence');
      game.settings.set(MODULE_ID, 'windowOpen', true);
    }
  }

  async close(options = {}) {
    game.settings.set(MODULE_ID, 'windowOpen', false);
    return super.close(options);
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
      regenerate: InfluenceOutputApp.regenerate,
      backToBuilder: InfluenceOutputApp.backToBuilder
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

  static async backToBuilder() {
    // Close output and reopen input
    if (outputApp) {
      outputApp.close();
      outputApp = null;
    }
    openEncounterInput();
  }
}


// ============================================================================
// Research Output Modal
// ============================================================================

class ResearchOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;

    // Persist the encounter and window state
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'research');
      game.settings.set(MODULE_ID, 'windowOpen', true);
    }
  }

  async close(options = {}) {
    game.settings.set(MODULE_ID, 'windowOpen', false);
    return super.close(options);
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
      regenerate: ResearchOutputApp.regenerate,
      backToBuilder: ResearchOutputApp.backToBuilder
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

    // Get DCs from encounter (research encounters have dcs object)
    const dcs = this.encounter.dcs || {};

    let html = '<div class="complications-list">';

    complications.forEach((c, index) => {
      html += `<div class="complication-card" data-complication-index="${index}">`;
      html += `<div class="complication-header">`;
      html += `<span class="complication-trigger">Bei ${c.atRp} RP</span>`;
      html += `</div>`;
      html += `<div class="complication-event">${c.event}</div>`;

      // Handle structured save/condition OR legacy mechanic string
      if (c.save && c.condition) {
        // New structured format
        const dcValue = c.save.dc === 'standard' ? (dcs.standard || 15) :
                        c.save.dc === 'easy' ? (dcs.easy || 13) :
                        c.save.dc === 'hard' ? (dcs.hard || 17) :
                        c.save.dc;
        const saveType = c.save.type.charAt(0).toUpperCase() + c.save.type.slice(1);
        html += `<div class="complication-mechanic">`;
        html += `<strong>Save:</strong> ${saveType} DC ${dcValue}<br>`;
        html += `<strong>Bei Fehlschlag:</strong> ${c.condition.name.charAt(0).toUpperCase() + c.condition.name.slice(1)} ${c.condition.value}`;
        html += `</div>`;
      } else if (c.mechanic) {
        // Legacy string format
        html += `<div class="complication-mechanic"><strong>Mechanik:</strong> ${c.mechanic}</div>`;
      }

      // Post to Chat button
      html += `<button class="post-to-chat" data-complication-index="${index}">`;
      html += `<i class="fas fa-comment"></i> Im Chat posten`;
      html += `</button>`;

      html += `</div>`;
    });

    html += '</div>';
    return html;
  }

  /**
   * Attach event listeners after render
   */
  _onRender(context, options) {
    // Attach event listeners for Post to Chat buttons on complications
    this.element.querySelectorAll('.complication-card .post-to-chat').forEach(btn => {
      btn.addEventListener('click', async (event) => {
        const index = parseInt(event.currentTarget.dataset.complicationIndex);
        await this.postComplicationToChat(index);
      });
    });
  }

  /**
   * Post a complication to chat with clickable save button
   */
  async postComplicationToChat(index) {
    const comp = this.encounter.complications?.[index];
    if (!comp) return;

    const dcs = this.encounter.dcs || {};

    let content = `<div class="pf2e-ability-chat complication-chat">`;
    content += `<h3><i class="fas fa-exclamation-triangle"></i> Komplikation (${comp.atRp} RP)</h3>`;
    content += `<p class="complication-event">${comp.event}</p>`;

    // Handle structured save/condition OR legacy format
    if (comp.save && comp.condition) {
      const dcValue = comp.save.dc === 'standard' ? (dcs.standard || 15) :
                      comp.save.dc === 'easy' ? (dcs.easy || 13) :
                      comp.save.dc === 'hard' ? (dcs.hard || 17) :
                      comp.save.dc;

      // PF2E clickable save button
      content += `<p><strong>Saving Throw:</strong> @Check[type:${comp.save.type}|dc:${dcValue}]</p>`;
      content += `<p><strong>Bei Fehlschlag:</strong> ${comp.condition.name.charAt(0).toUpperCase() + comp.condition.name.slice(1)} ${comp.condition.value}</p>`;
    } else if (comp.mechanic) {
      content += `<p><strong>Mechanik:</strong> ${comp.mechanic}</p>`;
    }

    content += `</div>`;

    await ChatMessage.create({ content });
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

  static async backToBuilder() {
    // Close output and reopen input
    if (outputApp) {
      outputApp.close();
      outputApp = null;
    }
    openEncounterInput();
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

    // Persist the encounter and window state
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'chase');
      game.settings.set(MODULE_ID, 'windowOpen', true);
      console.log('Encounter Builder | Chase encounter saved to settings');
    }
  }

  async close(options = {}) {
    game.settings.set(MODULE_ID, 'windowOpen', false);
    return super.close(options);
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
      regenerate: ChaseOutputApp.regenerate,
      backToBuilder: ChaseOutputApp.backToBuilder
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
      // Determine card classes based on features
      const hasShortcut = obs.shortcut && obs.shortcut !== null;
      const hasSpecialEffect = obs.specialEffect && obs.specialEffect !== null;
      const cardClasses = ['obstacle-card'];
      if (hasShortcut) cardClasses.push('has-shortcut');
      if (hasSpecialEffect) cardClasses.push('has-special-effect');

      html += `<div class="${cardClasses.join(' ')}">
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

      // Render Shortcut if present
      if (hasShortcut) {
        const shortcut = obs.shortcut;
        html += `<div class="obstacle-shortcut">
          <div class="shortcut-header">
            <i class="fas fa-route"></i> <strong>Shortcut</strong>
            <span class="shortcut-dc">${shortcut.skill} DC ${shortcut.dc}</span>
          </div>
          <p class="shortcut-description">${shortcut.description || 'Bei Critical Success: Hindernis überspringen'}</p>
          ${shortcut.critFailEffect ? `<p class="shortcut-crit-fail"><i class="fas fa-exclamation-triangle"></i> Crit Fail: ${shortcut.critFailEffect}</p>` : ''}
        </div>`;
      }

      // Render Special Effect if present
      if (hasSpecialEffect) {
        const effect = obs.specialEffect;
        html += `<div class="obstacle-special-effect">
          <div class="special-effect-header">
            <i class="fas fa-bolt"></i> <strong>${effect.trigger || 'Critical Failure'}</strong>
          </div>
          <p class="special-effect-description">
            ${effect.damage ? `<span class="effect-damage">${effect.damage} ${effect.damageType || ''} Schaden</span>` : ''}
            ${effect.effect ? `<span class="effect-text">${effect.effect}</span>` : ''}
          </p>
        </div>`;
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

  static async backToBuilder() {
    // Close output and reopen input
    if (outputApp) {
      outputApp.close();
      outputApp = null;
    }
    openEncounterInput();
  }
}


// ============================================================================
// Dungeon Output Application
// ============================================================================

class DungeonOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;

    // Persist the encounter and window state
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'dungeon');
      game.settings.set(MODULE_ID, 'windowOpen', true);
      console.log('Encounter Builder | Dungeon encounter saved to settings');
    }
  }

  async close(options = {}) {
    game.settings.set(MODULE_ID, 'windowOpen', false);
    return super.close(options);
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
      copyPrompt: DungeonOutputApp.copyPrompt,
      backToBuilder: DungeonOutputApp.backToBuilder
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
    let html = '';

    // Concept
    const concept = this.encounter.concept;
    if (concept) {
      html += `<p class="dungeon-concept">${concept}</p>`;
    }

    // Faction (narratively connected encounters)
    const faction = this.encounter.faction;
    if (faction && faction.bossName) {
      html += `<div class="dungeon-faction">
        <div class="faction-header">
          <strong><i class="fas fa-crown"></i> Fraktion: ${faction.bossName}</strong>
        </div>
        <div class="faction-details">
          ${faction.bossPersonality ? `<p><strong>Persönlichkeit:</strong> ${faction.bossPersonality}</p>` : ''}
          ${faction.minions ? `<p><strong>Schergen:</strong> ${faction.minions}</p>` : ''}
          ${faction.motivation ? `<p><strong>Motivation:</strong> ${faction.motivation}</p>` : ''}
        </div>
      </div>`;
    }

    return html;
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

      // Trap Details (for trap rooms) - show hazard info and tactics
      if (room.roomType === 'trap' && (room.selectedHazard || room.trapDescription || room.trapTactics)) {
        html += `<div class="trap-details-container">`;

        // Selected Hazard with stats
        if (room.selectedHazard) {
          const hazardXP = room.hazardXP || '?';
          const hazardLevel = room.hazardLevel || '?';
          html += `<div class="trap-hazard-header">
            <strong><i class="fas fa-exclamation-triangle"></i> Falle: ${room.selectedHazard}</strong>
            <span class="trap-stats">(Level ${hazardLevel}, ${hazardXP} XP)</span>
          </div>`;
        }

        // Trap Description (how it looks in the room)
        if (room.trapDescription) {
          html += `<div class="trap-description">
            <strong>Beschreibung:</strong>
            <p>${room.trapDescription}</p>
          </div>`;
        }

        // Trap Tactics (GM hints - the important part!)
        if (room.trapTactics) {
          html += `<div class="trap-tactics">
            <strong><i class="fas fa-chess"></i> Taktik für den GM:</strong>
            <p>${room.trapTactics}</p>
          </div>`;
        }

        // Full hazard stats if available
        if (room.hazardDetails) {
          const h = room.hazardDetails;
          html += `<div class="trap-stats-block">
            <strong>Stats:</strong>
            <ul>
              ${h.ac ? `<li><strong>AC:</strong> ${h.ac}</li>` : ''}
              ${h.hp ? `<li><strong>HP:</strong> ${h.hp}${h.hardness ? ` (Hardness ${h.hardness})` : ''}</li>` : ''}
              ${h.stealth ? `<li><strong>Stealth:</strong> +${h.stealth}</li>` : ''}
              ${h.disable ? `<li><strong>Entschärfen:</strong> ${h.disable}</li>` : ''}
            </ul>
          </div>`;
        }

        html += `</div>`;
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

    // Faction (narratively connected encounters)
    if (encounter.faction && encounter.faction.bossName) {
      const f = encounter.faction;
      content += `## Fraktion\n`;
      content += `**👑 Anführer:** ${f.bossName}\n`;
      if (f.bossPersonality) content += `**Persönlichkeit:** ${f.bossPersonality}\n`;
      if (f.minions) content += `**Schergen:** ${f.minions}\n`;
      if (f.motivation) content += `**Motivation:** ${f.motivation}\n`;
      content += '\n';
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

        // Trap Details for journal export
        if (room.roomType === 'trap' && (room.selectedHazard || room.trapDescription || room.trapTactics)) {
          if (room.selectedHazard) {
            content += `**⚠️ Falle: ${room.selectedHazard}** (Level ${room.hazardLevel || '?'}, ${room.hazardXP || '?'} XP)\n\n`;
          }
          if (room.trapDescription) {
            content += `*${room.trapDescription}*\n\n`;
          }
          if (room.trapTactics) {
            content += `**Taktik für den GM:**\n${room.trapTactics}\n\n`;
          }
          if (room.hazardDetails) {
            const h = room.hazardDetails;
            content += `**Stats:** `;
            const stats = [];
            if (h.ac) stats.push(`AC ${h.ac}`);
            if (h.hp) stats.push(`HP ${h.hp}${h.hardness ? ` (Hardness ${h.hardness})` : ''}`);
            if (h.stealth) stats.push(`Stealth +${h.stealth}`);
            if (h.disable) stats.push(`Entschärfen: ${h.disable}`);
            content += stats.join(', ') + '\n\n';
          }
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

  static async backToBuilder() {
    // Close output and reopen input
    if (outputApp) {
      outputApp.close();
      outputApp = null;
    }
    openEncounterInput();
  }
}

// ============================================================================
// Infiltration Output Application
// ============================================================================

class InfiltrationOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;

    // Persist the encounter and window state
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'infiltration');
      game.settings.set(MODULE_ID, 'windowOpen', true);
      console.log('Encounter Builder | Infiltration encounter saved to settings');
    }
  }

  async close(options = {}) {
    game.settings.set(MODULE_ID, 'windowOpen', false);
    return super.close(options);
  }

  static DEFAULT_OPTIONS = {
    id: 'infiltration-builder-output',
    classes: ['encounter-builder', 'infiltration-output'],
    window: {
      title: 'Infiltration',
      icon: 'fas fa-mask',
      resizable: true
    },
    position: {
      width: 850,
      height: 900
    },
    actions: {
      saveJournal: InfiltrationOutputApp.saveAsJournal,
      regenerate: InfiltrationOutputApp.regenerate,
      backToBuilder: InfiltrationOutputApp.backToBuilder
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/infiltration-output.hbs`
    }
  };

  async _prepareContext() {
    return {
      encounter: this.encounter,
      headerHtml: this._formatHeader(),
      objectivesHtml: this._formatObjectives(),
      obstaclesHtml: this._formatObstacles(),
      awarenessHtml: this._formatAwarenessThresholds(),
      complicationsHtml: this._formatComplications(),
      opportunitiesHtml: this._formatOpportunities(),
      preparationHtml: this._formatPreparation(),
      edgePointsHtml: this._formatEdgePoints(),
      failureHtml: this._formatFailure()
    };
  }

  _formatHeader() {
    const name = this.encounter.name || 'Infiltration';
    const location = this.encounter.location || '';
    const complexity = this.encounter.complexity || 10;

    const typeLabels = {
      custom: 'Custom',
      heist: 'Heist',
      sabotage: 'Sabotage',
      rescue: 'Rescue',
      assassination: 'Assassination',
      extraction: 'Extraction'
    };

    const typeLabel = typeLabels[this.encounter.infiltrationType] || 'Infiltration';

    let html = `<h1 class="infiltration-title">${name}</h1>`;
    html += `<div class="infiltration-meta">`;
    html += `<span class="infiltration-type-badge">${typeLabel}</span>`;
    html += `<span class="infiltration-complexity">${complexity} IP Ziel</span>`;
    if (location) html += `<span class="infiltration-location">${location}</span>`;
    html += `</div>`;
    return html;
  }

  _formatObjectives() {
    const objectives = this.encounter.objectives;
    if (!objectives || objectives.length === 0) {
      return '<p>Keine Objectives definiert.</p>';
    }

    let html = '<ol class="objectives-list">';
    objectives.forEach(obj => {
      const ip = obj.infiltrationPoints || obj.ip || '?';
      html += `<li class="objective-item">
        <span class="objective-name">${obj.name || obj}</span>
        <span class="objective-ip">${ip} IP</span>
        ${obj.description ? `<p class="objective-desc">${obj.description}</p>` : ''}
      </li>`;
    });
    html += '</ol>';
    return html;
  }

  _formatObstacles() {
    const obstacles = this.encounter.obstacles;
    if (!obstacles || obstacles.length === 0) {
      return '<p>Keine Obstacles generiert.</p>';
    }

    let html = '<div class="obstacles-grid">';
    obstacles.forEach(obs => {
      const ip = obs.infiltrationPoints || obs.ip || '?';
      const type = obs.type === 'group' ? 'Group' : 'Individual';
      const typeClass = obs.type === 'group' ? 'obstacle-group' : 'obstacle-individual';

      html += `<div class="obstacle-card ${typeClass}">
        <div class="obstacle-header">
          <h4 class="obstacle-name">${obs.name}</h4>
          <span class="obstacle-ip">${ip} IP</span>
          <span class="obstacle-type-badge ${typeClass}">${type}</span>
        </div>
        <p class="obstacle-description">${obs.description || ''}</p>
        <div class="obstacle-overcome">
          <strong>Overcome:</strong> ${obs.overcome || obs.skills?.join(', ') || 'Skill Check'}
        </div>
        ${obs.criticalFailure ? `<div class="obstacle-crit-fail"><strong>Critical Failure:</strong> ${obs.criticalFailure}</div>` : ''}
      </div>`;
    });
    html += '</div>';
    return html;
  }

  _formatAwarenessThresholds() {
    const thresholds = this.encounter.awarenessThresholds;
    if (!thresholds || thresholds.length === 0) {
      // Default thresholds
      return `
        <table class="awareness-table">
          <thead>
            <tr><th>AP</th><th>Effekt</th></tr>
          </thead>
          <tbody>
            <tr><td>5</td><td>DCs +1, erste Complication</td></tr>
            <tr><td>10</td><td>Zweite Complication</td></tr>
            <tr><td>15</td><td>DCs +2, dritte Complication</td></tr>
            <tr><td>20</td><td>Fehlschlag - Infiltration aufgeflogen!</td></tr>
          </tbody>
        </table>`;
    }

    let html = '<table class="awareness-table"><thead><tr><th>AP</th><th>Effekt</th></tr></thead><tbody>';
    thresholds.forEach(t => {
      const apValue = t.points || t.ap || '?';
      html += `<tr>
        <td class="ap-value">${apValue}</td>
        <td class="ap-effect">${t.effect || t.description || ''}</td>
      </tr>`;
    });
    html += '</tbody></table>';
    return html;
  }

  _formatComplications() {
    const complications = this.encounter.complications;
    if (!complications || complications.length === 0) {
      return '<p>Keine Complications generiert.</p>';
    }

    let html = '<div class="complications-list">';
    complications.forEach(comp => {
      html += `<div class="complication-card">
        <h4 class="complication-name">${comp.name}</h4>
        ${comp.trigger ? `<div class="complication-trigger"><strong>Trigger:</strong> ${comp.trigger}</div>` : ''}
        <p class="complication-description">${comp.description || ''}</p>
        ${comp.overcome ? `<div class="complication-overcome"><strong>Overcome:</strong> ${comp.overcome}</div>` : ''}
        <div class="complication-results">
          ${comp.success ? `<div class="result-success"><strong>Success:</strong> ${comp.success}</div>` : ''}
          ${comp.failure ? `<div class="result-failure"><strong>Failure:</strong> ${comp.failure}</div>` : ''}
          ${comp.criticalFailure ? `<div class="result-crit-fail"><strong>Critical Failure:</strong> ${comp.criticalFailure}</div>` : ''}
        </div>
      </div>`;
    });
    html += '</div>';
    return html;
  }

  _formatOpportunities() {
    const opportunities = this.encounter.opportunities;
    if (!opportunities || opportunities.length === 0) {
      return '<p>Keine Opportunities generiert.</p>';
    }

    let html = '<div class="opportunities-list">';
    opportunities.forEach(opp => {
      html += `<div class="opportunity-card">
        <h4 class="opportunity-name">${opp.name}</h4>
        ${opp.requirements ? `<div class="opportunity-requirements"><strong>Requirements:</strong> ${opp.requirements}</div>` : ''}
        <p class="opportunity-description">${opp.description || ''}</p>
        <div class="opportunity-effect"><strong>Effect:</strong> ${opp.effect || ''}</div>
        ${opp.risk ? `<div class="opportunity-risk"><strong>Risk:</strong> ${opp.risk}</div>` : ''}
      </div>`;
    });
    html += '</div>';
    return html;
  }

  _formatPreparation() {
    const activities = this.encounter.preparationActivities;
    if (!activities || activities.length === 0) {
      return '<p>Keine Preparation Activities generiert.</p>';
    }

    let html = '<div class="preparation-grid">';
    activities.forEach(act => {
      html += `<div class="preparation-card">
        <h4 class="preparation-name">${act.name}</h4>
        ${act.traits ? `<div class="preparation-traits">${act.traits.join(', ')}</div>` : ''}
        ${act.cost ? `<div class="preparation-cost"><strong>Cost:</strong> ${act.cost}</div>` : ''}
        <div class="preparation-check"><strong>Check:</strong> ${act.check || act.skill || 'Skill Check'}</div>
        <div class="preparation-results">
          ${act.criticalSuccess ? `<div class="result-crit-success"><strong>Critical Success:</strong> ${act.criticalSuccess}</div>` : ''}
          ${act.success ? `<div class="result-success"><strong>Success:</strong> ${act.success}</div>` : ''}
          ${act.failure ? `<div class="result-failure"><strong>Failure:</strong> ${act.failure}</div>` : ''}
          ${act.criticalFailure ? `<div class="result-crit-fail"><strong>Critical Failure:</strong> ${act.criticalFailure}</div>` : ''}
        </div>
      </div>`;
    });
    html += '</div>';
    return html;
  }

  _formatEdgePoints() {
    const edgePoints = this.encounter.edgePoints;

    let html = `<div class="edge-points-info">
      <p><strong>Edge Points (EP)</strong> werden durch erfolgreiche Preparation Activities gewonnen.</p>
      <p>Ein EP kann ausgegeben werden, um ein <strong>Failure zu einem Success</strong> zu konvertieren.</p>`;

    if (edgePoints && edgePoints.length > 0) {
      html += '<ul class="edge-points-list">';
      edgePoints.forEach(ep => {
        html += `<li>${ep.source || ep.name}: ${ep.description || ep.effect || '+1 EP'}</li>`;
      });
      html += '</ul>';
    }

    html += '</div>';
    return html;
  }

  _formatFailure() {
    const failure = this.encounter.failure || this.encounter.failureConsequence;
    if (!failure) {
      return '<p>Bei 20 Awareness Points ist die Infiltration fehlgeschlagen. Die Gruppe wurde entdeckt!</p>';
    }

    if (typeof failure === 'string') {
      return `<p>${failure}</p>`;
    }

    let html = '';
    if (failure.description) html += `<p>${failure.description}</p>`;
    if (failure.consequences && failure.consequences.length > 0) {
      html += '<ul class="failure-consequences">';
      failure.consequences.forEach(c => {
        html += `<li>${c}</li>`;
      });
      html += '</ul>';
    }
    return html || '<p>Die Infiltration ist fehlgeschlagen!</p>';
  }

  static async saveAsJournal() {
    const encounter = outputApp?.encounter;
    if (!encounter) return;

    const title = encounter.name || 'Infiltration';

    // Build markdown content
    let content = `# ${title}\n\n`;

    // Meta info
    if (encounter.location) content += `**Location:** ${encounter.location}\n`;
    if (encounter.complexity) content += `**Complexity:** ${encounter.complexity} IP\n`;
    content += '\n';

    // Objectives
    if (encounter.objectives?.length > 0) {
      content += `## Objectives\n\n`;
      encounter.objectives.forEach((obj, idx) => {
        const name = obj.name || obj;
        const ip = obj.infiltrationPoints || obj.ip || '?';
        content += `${idx + 1}. **${name}** (${ip} IP)\n`;
        if (obj.description) content += `   ${obj.description}\n`;
      });
      content += '\n';
    }

    // Obstacles
    if (encounter.obstacles?.length > 0) {
      content += `## Obstacles\n\n`;
      encounter.obstacles.forEach(obs => {
        const ip = obs.infiltrationPoints || obs.ip || '?';
        const type = obs.type === 'group' ? 'Group' : 'Individual';
        content += `### ${obs.name} (${ip} IP, ${type})\n`;
        if (obs.description) content += `${obs.description}\n\n`;
        if (obs.overcome) content += `**Overcome:** ${obs.overcome}\n`;
        if (obs.criticalFailure) content += `**Critical Failure:** ${obs.criticalFailure}\n`;
        content += '\n';
      });
    }

    // Awareness Thresholds
    content += `## Awareness Thresholds\n\n`;
    if (encounter.awarenessThresholds?.length > 0) {
      encounter.awarenessThresholds.forEach(t => {
        content += `- **${t.points || t.ap} AP:** ${t.effect || t.description}\n`;
      });
    } else {
      content += `- **5 AP:** DCs +1, Complication\n`;
      content += `- **10 AP:** Complication\n`;
      content += `- **15 AP:** DCs +2, Complication\n`;
      content += `- **20 AP:** Fehlschlag\n`;
    }
    content += '\n';

    // Complications
    if (encounter.complications?.length > 0) {
      content += `## Complications\n\n`;
      encounter.complications.forEach(comp => {
        content += `### ${comp.name}\n`;
        if (comp.trigger) content += `**Trigger:** ${comp.trigger}\n`;
        if (comp.description) content += `${comp.description}\n`;
        if (comp.overcome) content += `**Overcome:** ${comp.overcome}\n`;
        if (comp.success) content += `**Success:** ${comp.success}\n`;
        if (comp.failure) content += `**Failure:** ${comp.failure}\n`;
        content += '\n';
      });
    }

    // Opportunities
    if (encounter.opportunities?.length > 0) {
      content += `## Opportunities\n\n`;
      encounter.opportunities.forEach(opp => {
        content += `### ${opp.name}\n`;
        if (opp.requirements) content += `**Requirements:** ${opp.requirements}\n`;
        if (opp.description) content += `${opp.description}\n`;
        if (opp.effect) content += `**Effect:** ${opp.effect}\n`;
        if (opp.risk) content += `**Risk:** ${opp.risk}\n`;
        content += '\n';
      });
    }

    // Preparation Activities
    if (encounter.preparationActivities?.length > 0) {
      content += `## Preparation Activities\n\n`;
      encounter.preparationActivities.forEach(act => {
        content += `### ${act.name}\n`;
        if (act.check) content += `**Check:** ${act.check}\n`;
        if (act.success) content += `**Success:** ${act.success}\n`;
        if (act.failure) content += `**Failure:** ${act.failure}\n`;
        content += '\n';
      });
    }

    // Failure
    if (encounter.failure || encounter.failureConsequence) {
      content += `## Bei Fehlschlag\n\n`;
      const failure = encounter.failure || encounter.failureConsequence;
      if (typeof failure === 'string') {
        content += `${failure}\n`;
      } else if (failure.description) {
        content += `${failure.description}\n`;
      }
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

  static async backToBuilder() {
    // Close output and reopen input
    if (outputApp) {
      outputApp.close();
      outputApp = null;
    }
    openEncounterInput();
  }
}


// ============================================================================
// Lair Output Application (Boss with Lair Actions)
// ============================================================================

class LairOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;

    // Persist the encounter and window state
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'lair');
      game.settings.set(MODULE_ID, 'windowOpen', true);
      console.log('Encounter Builder | Lair encounter saved to settings');
    }
  }

  async close(options = {}) {
    game.settings.set(MODULE_ID, 'windowOpen', false);
    return super.close(options);
  }

  static DEFAULT_OPTIONS = {
    id: 'lair-builder-output',
    classes: ['encounter-builder', 'lair-output'],
    window: {
      title: 'Lair Boss',
      icon: 'fas fa-dragon',
      resizable: true
    },
    position: {
      width: 850,
      height: 900
    },
    actions: {
      saveJournal: LairOutputApp.saveAsJournal,
      regenerate: LairOutputApp.regenerate,
      backToBuilder: LairOutputApp.backToBuilder
    }
  };

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/lair-output.hbs`
    }
  };

  async _prepareContext() {
    return {
      encounter: this.encounter,
      headerHtml: this._formatHeader(),
      scenicHtml: this._formatScenicDescription(),
      bossStatsHtml: this._formatBossStats(),
      minionStatsHtml: this._formatMinionStats(),
      lairActionsHtml: this._formatLairActions(),
      tacticsHtml: this._formatTactics()
    };
  }

  _formatHeader() {
    const bossStats = this.encounter.bossStats || {};
    const bossName = bossStats.name || this.encounter.selectedCreature || 'Boss';
    const bossLevel = this.encounter.bossLevel || bossStats.level || '?';
    const partyLevel = this.encounter.partyLevel || '?';
    const difficulty = this.encounter.difficulty === 'deadly' ? 'Toedlich' : 'Schwer';
    const terrain = this.encounter.terrain || 'unknown';

    const terrainLabels = {
      cave: 'Hoehle', ruin: 'Ruine', forest: 'Wald', swamp: 'Sumpf',
      mountain: 'Berg', desert: 'Wueste', underwater: 'Unterwasser',
      volcano: 'Vulkan', ice: 'Eiswueste', plains: 'Ebene',
      jungle: 'Dschungel', graveyard: 'Friedhof', tower: 'Turm'
    };

    let html = `<h1 class="lair-title">${bossName}</h1>`;
    html += `<div class="lair-meta">`;
    html += `<span class="lair-level">Level ${bossLevel}</span>`;
    html += `<span class="lair-difficulty">${difficulty}</span>`;
    html += `<span class="lair-terrain">${terrainLabels[terrain] || terrain}</span>`;
    html += `<span class="lair-party">Party: L${partyLevel}</span>`;
    html += `</div>`;
    return html;
  }

  _formatScenicDescription() {
    const scenic = this.encounter.scenicDescription || {};
    let html = '';

    // Combine battlefield + lair into one scene-setting description
    const parts = [];
    if (scenic.battlefield) parts.push(scenic.battlefield);
    if (scenic.lair) parts.push(scenic.lair);

    if (parts.length > 0) {
      html += `<div class="scene-description">`;
      html += `<p>${parts.join('</p><p>')}</p>`;
      html += `</div>`;
    }

    return html || '<p>Keine Beschreibung verfuegbar.</p>';
  }

  _formatBossStats() {
    const stats = this.encounter.bossStats;
    const scenic = this.encounter.scenicDescription || {};

    let html = '';

    // Monster description (moved from scenic section)
    if (scenic.monster) {
      html += `<div class="boss-description">`;
      html += `<p>${scenic.monster}</p>`;
      html += `</div>`;
    }

    // HP only (doubled, highlighted)
    if (stats) {
      html += `<div class="boss-hp">`;
      html += `<span class="hp-label">HP</span>`;
      html += `<span class="hp-value">${stats.hp}</span>`;
      html += `<span class="hp-note">(${stats.originalHp} x2)</span>`;
      html += `</div>`;
    }

    return html || '<p>Keine Boss-Informationen verfuegbar.</p>';
  }

  _formatMinionStats() {
    const stats = this.encounter.minionStats;
    if (!stats) return '';

    let html = `<div class="minion-stats">`;
    html += `<h4><i class="fas fa-users"></i> Minion: ${stats.name}</h4>`;
    html += `<div class="minion-grid">`;
    html += `<span><strong>Level:</strong> ${stats.level}</span>`;
    html += `<span><strong>AC:</strong> ${stats.ac || '?'}</span>`;
    html += `<span><strong>HP:</strong> ${stats.hp} (Minion-Regel)</span>`;
    html += `</div>`;
    html += `<p class="minion-note">${stats.note || 'Stirbt bei einem erfolgreichen Treffer.'}</p>`;
    html += `</div>`;

    return html;
  }

  _formatLairActions() {
    const actions = this.encounter.lairActions;
    if (!actions || actions.length === 0) {
      return '<p>Keine Lair Actions definiert.</p>';
    }

    let html = '';
    actions.forEach((action, index) => {
      const actionCost = action.actionCost || 1;
      const actionIcons = '◆'.repeat(actionCost);

      html += `<div class="lair-action pf2e-ability" data-action-index="${index}">`;

      // Header with name, action cost, and recharge
      html += `<div class="ability-header">`;
      html += `<h4 class="ability-name">${action.name}</h4>`;
      html += `<span class="action-glyph">${actionIcons}</span>`;
      if (action.recharge) {
        html += `<span class="recharge-badge">Recharge ${action.recharge}</span>`;
      }
      html += `</div>`;

      // Traits
      if (action.traits && action.traits.length > 0) {
        html += `<div class="ability-traits">`;
        action.traits.forEach(trait => {
          html += `<span class="trait">${trait}</span>`;
        });
        html += `</div>`;
      }

      // Content
      html += `<div class="ability-content">`;

      // Area
      if (action.area) {
        html += `<p><strong>${action.area.size}-foot ${action.area.type}</strong></p>`;
      }

      // Description
      if (action.description) {
        html += `<p class="ability-desc">${action.description}</p>`;
      }

      // Save (readable format for display)
      if (action.save) {
        const saveType = action.save.type.charAt(0).toUpperCase() + action.save.type.slice(1);
        const basicText = action.save.basic ? ' (Basic)' : '';
        html += `<p><strong>Saving Throw:</strong> ${saveType} DC ${action.save.dc}${basicText}</p>`;
      }

      // Damage (readable format for display)
      if (action.damage) {
        const damageType = action.damage.type.charAt(0).toUpperCase() + action.damage.type.slice(1);
        html += `<p><strong>Damage:</strong> ${action.damage.formula} ${damageType}</p>`;
      }

      // All 4 Outcomes (PF2E standard)
      if (action.criticalSuccess || action.success || action.failure || action.criticalFailure) {
        html += `<hr class="outcome-divider">`;
        if (action.criticalSuccess) {
          html += `<p><strong>Critical Success:</strong> ${action.criticalSuccess}</p>`;
        }
        if (action.success) {
          html += `<p><strong>Success:</strong> ${action.success}</p>`;
        }
        if (action.failure) {
          html += `<p><strong>Failure:</strong> ${action.failure}</p>`;
        }
        if (action.criticalFailure) {
          html += `<p><strong>Critical Failure:</strong> ${action.criticalFailure}</p>`;
        }
      }

      // Legacy mechanics field (for backwards compatibility)
      if (action.mechanics && !action.save && !action.damage) {
        html += `<p><strong>Mechanik:</strong> ${action.mechanics}</p>`;
      }

      html += `</div>`; // ability-content

      // Post to Chat button
      html += `<button class="post-to-chat" data-action-index="${index}">`;
      html += `<i class="fas fa-comment"></i> Im Chat posten`;
      html += `</button>`;

      // Roll Recharge button (if applicable)
      if (action.recharge) {
        html += `<button class="roll-recharge" data-action-index="${index}">`;
        html += `<i class="fas fa-dice-d6"></i> Recharge wuerfeln`;
        html += `</button>`;
      }

      html += `</div>`; // lair-action
    });

    return html;
  }

  _formatTactics() {
    const tactics = this.encounter.tactics;
    if (!tactics) return '<p>Keine Taktik-Hinweise.</p>';

    return `<p>${tactics}</p>`;
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Attach event listeners for Post to Chat buttons
    this.element.querySelectorAll('.post-to-chat').forEach(btn => {
      btn.addEventListener('click', async (event) => {
        const index = parseInt(event.currentTarget.dataset.actionIndex);
        await this.postLairActionToChat(index);
      });
    });

    // Attach event listeners for Roll Recharge buttons
    this.element.querySelectorAll('.roll-recharge').forEach(btn => {
      btn.addEventListener('click', async (event) => {
        const index = parseInt(event.currentTarget.dataset.actionIndex);
        await this.rollRecharge(index);
      });
    });
  }

  // Helper: Convert condition names to clickable @UUID links
  // Format from Fear spell: @UUID[Compendium.pf2e.conditionitems.Item.Frightened]{Frightened 1}
  _enrichConditions(text) {
    if (!text) return text;

    // Official PF2E conditions - use exact names as they appear in compendium
    const conditions = [
      'Frightened', 'Sickened', 'Drained', 'Slowed', 'Stunned', 'Clumsy',
      'Enfeebled', 'Stupefied', 'Blinded', 'Deafened', 'Fascinated',
      'Fleeing', 'Paralyzed', 'Petrified', 'Prone', 'Restrained',
      'Immobilized', 'Off-Guard', 'Hidden', 'Invisible', 'Concealed',
      'Grabbed', 'Quickened', 'Fatigued', 'Unconscious', 'Dying',
      'Wounded', 'Doomed', 'Confused', 'Controlled', 'Dazzled',
      'Encumbered', 'Undetected', 'Unnoticed'
    ];

    let enriched = text;
    for (const condition of conditions) {
      // Match "Condition X" or just "Condition" (case insensitive)
      const regex = new RegExp(`\\b(${condition})\\s*(\\d*)\\b`, 'gi');
      enriched = enriched.replace(regex, (match, name, value) => {
        const displayName = value ? `${condition} ${value}` : condition;
        return `@UUID[Compendium.pf2e.conditionitems.Item.${condition}]{${displayName}}`;
      });
    }
    return enriched;
  }

  async postLairActionToChat(actionIndex) {
    const action = this.encounter.lairActions?.[actionIndex];
    if (!action) return;

    const actionCost = action.actionCost || 1;
    const actionIcons = '◆'.repeat(actionCost);

    // Build chat message content with Foundry enrichers
    let content = `<div class="pf2e-ability-chat">`;
    content += `<h3>${action.name} <span class="action-glyph">${actionIcons}</span></h3>`;

    // Traits
    if (action.traits && action.traits.length > 0) {
      content += `<p class="action-traits">${action.traits.join(', ')}</p>`;
    }

    // Area with clickable @Template
    if (action.area) {
      content += `<p><strong>Area:</strong> @Template[${action.area.type}|distance:${action.area.size}]{${action.area.size}-foot ${action.area.type}}</p>`;
    }

    // Description
    if (action.description) {
      content += `<p>${action.description}</p>`;
    }

    // Save (Foundry PF2E format)
    if (action.save) {
      const basicText = action.save.basic ? '|basic:true' : '';
      content += `<p><strong>Saving Throw:</strong> @Check[type:${action.save.type}|dc:${action.save.dc}${basicText}]</p>`;
    }

    // Damage (Foundry inline roll format)
    if (action.damage) {
      content += `<p><strong>Damage:</strong> @Damage[${action.damage.formula}[${action.damage.type}]]</p>`;
    }

    // All 4 Outcomes with enriched conditions
    if (action.criticalSuccess || action.success || action.failure || action.criticalFailure) {
      content += `<hr>`;
      if (action.criticalSuccess) {
        content += `<p><strong>Critical Success:</strong> ${this._enrichConditions(action.criticalSuccess)}</p>`;
      }
      if (action.success) {
        content += `<p><strong>Success:</strong> ${this._enrichConditions(action.success)}</p>`;
      }
      if (action.failure) {
        content += `<p><strong>Failure:</strong> ${this._enrichConditions(action.failure)}</p>`;
      }
      if (action.criticalFailure) {
        content += `<p><strong>Critical Failure:</strong> ${this._enrichConditions(action.criticalFailure)}</p>`;
      }
    }

    content += `</div>`;

    // Send to chat - Foundry v13 handles enrichment automatically during render
    await ChatMessage.create({ content });
  }

  async rollRecharge(actionIndex) {
    const action = this.encounter.lairActions?.[actionIndex];
    if (!action || !action.recharge) return;

    // Parse recharge value (e.g., "5-6" -> minimum 5, "6" -> minimum 6, "4-6" -> minimum 4)
    let minValue = 6;
    if (action.recharge === '5-6') minValue = 5;
    else if (action.recharge === '4-6') minValue = 4;
    else if (action.recharge === '6') minValue = 6;

    // Roll the die
    const roll = await new Roll('1d6').evaluate();

    const recharged = roll.total >= minValue;

    if (recharged) {
      // Success: Show flavor text to ALL players
      const flavorText = action.rechargeFlavorText || `${action.name} ist wieder bereit!`;
      await ChatMessage.create({
        content: `<div class="recharge-success">
          <p class="recharge-flavor">${flavorText}</p>
        </div>`
      });
    } else {
      // Failure: Only GM sees this
      await ChatMessage.create({
        content: `<div class="recharge-fail">
          <i class="fas fa-dice-d6"></i> ${action.name} - Recharge ${action.recharge}: <strong>${roll.total}</strong> (nicht aufgeladen)
        </div>`,
        whisper: [game.user.id]
      });
    }

    return recharged;
  }

  static async saveAsJournal() {
    const encounter = outputApp?.encounter;
    if (!encounter) return;

    const bossName = encounter.bossStats?.name || encounter.selectedCreature || 'Boss';
    const title = `Lair: ${bossName}`;

    // Build markdown content
    let content = `# ${title}\n\n`;

    // Meta info
    content += `**Level:** ${encounter.bossLevel || '?'}\n`;
    content += `**Party Level:** ${encounter.partyLevel || '?'}\n`;
    content += `**Terrain:** ${encounter.terrain || '?'}\n`;
    content += `**Difficulty:** ${encounter.difficulty === 'deadly' ? 'Toedlich' : 'Schwer'}\n\n`;

    // Scenic Description
    const scenic = encounter.scenicDescription || {};
    if (scenic.battlefield) {
      content += `## Das Schlachtfeld\n${scenic.battlefield}\n\n`;
    }
    if (scenic.monster) {
      content += `## Der Boss\n${scenic.monster}\n\n`;
    }
    if (scenic.lair) {
      content += `## Der Bau\n${scenic.lair}\n\n`;
    }

    // Boss Stats
    const stats = encounter.bossStats;
    if (stats) {
      content += `## Boss Stats\n`;
      content += `- **HP:** ${stats.hp} (${stats.originalHp} x2)\n`;
      content += `- **AC:** ${stats.ac || '?'}\n`;
      content += `- **Fort/Ref/Will:** +${stats.fortitude || '?'}/+${stats.reflex || '?'}/+${stats.will || '?'}\n`;
      if (stats.immunities?.length > 0) content += `- **Immunitaeten:** ${stats.immunities.join(', ')}\n`;
      if (stats.resistances?.length > 0) content += `- **Resistenzen:** ${stats.resistances.join(', ')}\n`;
      if (stats.weaknesses?.length > 0) content += `- **Schwaechen:** ${stats.weaknesses.join(', ')}\n`;
      content += `\n**Boss-Regeln:** Zwei Initiativen pro Runde. HP bereits verdoppelt.\n\n`;
    }

    // Minion Stats
    const minion = encounter.minionStats;
    if (minion) {
      content += `## Minion: ${minion.name}\n`;
      content += `- **Level:** ${minion.level}\n`;
      content += `- **AC:** ${minion.ac || '?'}\n`;
      content += `- **HP:** ${minion.hp} (Minion-Regel: stirbt bei einem Treffer)\n\n`;
    }

    // Lair Actions
    if (encounter.lairActions?.length > 0) {
      content += `## Lair Actions\n\n`;
      encounter.lairActions.forEach(action => {
        const cost = '◆'.repeat(action.actionCost || 1);
        content += `### ${action.name} ${cost}\n`;
        if (action.trigger) content += `**Trigger:** ${action.trigger}\n`;
        if (action.description) content += `${action.description}\n`;
        if (action.mechanics) content += `**Mechanik:** ${action.mechanics}\n`;
        content += '\n';
      });
    }

    // Tactics
    if (encounter.tactics) {
      content += `## Taktik\n${encounter.tactics}\n`;
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

  static async backToBuilder() {
    // Close output and reopen input
    if (outputApp) {
      outputApp.close();
      outputApp = null;
    }
    openEncounterInput();
  }
}


// ============================================================================
// TravelEncounterOutputApp: A Chance Meeting Output
// ============================================================================

class TravelEncounterOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter) {
    super();
    this.encounter = encounter;

    // Persist the encounter and window state
    if (encounter) {
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'travel');
      game.settings.set(MODULE_ID, 'windowOpen', true);
      console.log('Encounter Builder | Travel encounter saved to settings');
    }
  }

  async close(options = {}) {
    game.settings.set(MODULE_ID, 'windowOpen', false);
    return super.close(options);
  }

  static DEFAULT_OPTIONS = {
    id: 'travel-encounter-output',
    classes: ['encounter-builder', 'travel-output'],
    window: {
      title: 'Travel Encounter',
      icon: 'fas fa-road',
      resizable: true
    },
    position: {
      width: 700,
      height: 'auto'
    },
    actions: {
      saveJournal: TravelEncounterOutputApp.saveAsJournal,
      regenerate: TravelEncounterOutputApp.regenerate,
      backToBuilder: TravelEncounterOutputApp.backToBuilder
    }
  };

  // Override to set dynamic title based on encounter type
  get title() {
    return this.encounter?.encounterTypeLabel || 'Travel Encounter';
  }

  static PARTS = {
    content: {
      template: `modules/${MODULE_ID}/templates/travel-output.hbs`
    }
  };

  async _prepareContext() {
    // Campaign mode labels
    const modeLabels = {
      standalone: 'Standalone',
      front_specific: 'Front-spezifisch',
      personal: 'Persönlich'
    };

    // Debug: Log campaign metadata
    console.log('Encounter Builder | Campaign metadata:', {
      campaignSpecific: this.encounter?.campaignSpecific,
      campaignMode: this.encounter?.campaignMode,
      campaignDanger: this.encounter?.campaignDanger,
      campaignFront: this.encounter?.campaignFront,
      campaignSecretXP: this.encounter?.campaignSecretXP,
      campaignSecretText: this.encounter?.campaignSecretText,
      campaignPC: this.encounter?.campaignPC,
      campaignHook: this.encounter?.campaignHook
    });

    return {
      encounter: this.encounter,
      headerHtml: this._formatHeader(),
      descriptionHtml: this._formatDescription(),
      campaignModeLabel: modeLabels[this.encounter?.campaignMode] || this.encounter?.campaignMode
    };
  }

  _formatHeader() {
    const title = this.encounter.title || 'Travel Encounter';
    const biome = this.encounter.biome || 'unknown';
    const encounterTypeLabel = this.encounter.encounterTypeLabel || 'A Chance Meeting';

    const biomeLabels = {
      coasts: 'Kueste', desert: 'Wueste', farmlands: 'Agrarland',
      forests: 'Wald', grasslands: 'Grasland', mountains: 'Gebirge',
      open_waters: 'Offenes Meer', swamps: 'Sumpf',
      underground: 'Untergrund', urban: 'Stadt', wildlands: 'Wildnis'
    };

    let html = `<h1 class="travel-title">${title}</h1>`;
    html += `<div class="travel-meta">`;
    html += `<span class="encounter-type-badge">${encounterTypeLabel}</span>`;
    html += `<span class="biome-badge">${biomeLabels[biome] || biome}</span>`;
    html += `</div>`;
    return html;
  }

  _formatDescription() {
    const description = this.encounter.description || '';
    return `<p>${description}</p>`;
  }

  static async saveAsJournal() {
    const encounter = this.encounter;
    if (!encounter) {
      ui.notifications.error('No encounter data to save');
      return;
    }

    const title = encounter.title || 'Travel Encounter';
    const biome = encounter.biome || 'unknown';
    const encounterTypeLabel = encounter.encounterTypeLabel || 'A Chance Meeting';

    const biomeLabels = {
      coasts: 'Kueste', desert: 'Wueste', farmlands: 'Agrarland',
      forests: 'Wald', grasslands: 'Grasland', mountains: 'Gebirge',
      open_waters: 'Offenes Meer', swamps: 'Sumpf',
      underground: 'Untergrund', urban: 'Stadt', wildlands: 'Wildnis'
    };

    let content = `<h2>${title}</h2>`;
    content += `<p><strong>Typ:</strong> ${encounterTypeLabel}</p>`;
    content += `<p><strong>Biom:</strong> ${biomeLabels[biome] || biome}</p>`;
    content += `<hr>`;
    content += `<p>${encounter.description || ''}</p>`;

    // Create journal entry
    const journal = await JournalEntry.create({
      name: `Travel: ${title}`,
      pages: [{
        name: title,
        type: 'text',
        text: { content }
      }]
    });

    ui.notifications.info(`Created journal: ${journal.name}`);
    journal.sheet.render(true);
  }

  static async regenerate() {
    // Auto-regenerate using the stored request
    if (!lastTravelRequest) {
      ui.notifications.error('No previous travel request to regenerate');
      return;
    }

    ui.notifications.info('Regenerating travel encounter...');

    try {
      const encounter = await generateEncounter(lastTravelRequest);

      // Update the encounter in the current app
      if (outputApp) {
        outputApp.encounter = encounter;
        // Persist the new encounter
        game.settings.set(MODULE_ID, 'lastEncounter', encounter);
        outputApp.render(true);
      }
    } catch (error) {
      console.error('Encounter Builder | Travel regeneration failed:', error);
      ui.notifications.error(`Failed to regenerate travel encounter: ${error.message}`);
    }
  }

  static async backToBuilder() {
    // Close output and reopen input
    if (outputApp) {
      outputApp.close();
      outputApp = null;
    }
    openEncounterInput();
  }
}


// ============================================================================
// SimpleCombatOutputApp: Lightweight Combat Output (4 sections only)
// ============================================================================

class SimpleCombatOutputApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(encounter, requestData) {
    super();
    this.encounter = encounter;
    this.requestData = requestData;
    console.log('Encounter Builder | Simple combat received:', encounter);
    if (encounter) {
      // Store requestData in encounter for persistence
      encounter.requestData = requestData;
      game.settings.set(MODULE_ID, 'lastEncounter', encounter);
      game.settings.set(MODULE_ID, 'lastEncounterType', 'simple-combat');
      game.settings.set(MODULE_ID, 'windowOpen', true);
    }
  }

  async close(options = {}) {
    game.settings.set(MODULE_ID, 'windowOpen', false);
    return super.close(options);
  }

  static DEFAULT_OPTIONS = {
    id: 'simple-combat-output',
    classes: ['encounter-builder', 'combat-output'],
    window: { title: 'Combat Encounter', icon: 'fas fa-swords', resizable: true },
    position: { width: 800, height: 700 },
    actions: {
      saveJournal: SimpleCombatOutputApp.saveAsJournal,
      regenerate: SimpleCombatOutputApp.regenerate,
      backToBuilder: SimpleCombatOutputApp.backToBuilder
    }
  };

  static PARTS = {
    content: { template: `modules/${MODULE_ID}/templates/combat-output.hbs` }
  };

  async _prepareContext() {
    const parsed = this._parseRawOutput(this.encounter.rawOutput || '');
    console.log('Encounter Builder | Parsed XP:', parsed.xpTotal, 'from monsters:', parsed.monsters?.substring(0, 100));
    return {
      title: parsed.title?.trim() || 'Combat Encounter',
      difficulty: this.requestData?.difficulty || 'severe',
      partyLevel: this.requestData?.partyLevel || 1,
      partySize: this.requestData?.partySize || 4,
      xpTotal: parsed.xpTotal || 0,
      sceneHtml: this._formatMarkdown(parsed.scene || 'Keine Szene.'),
      monstersTableHtml: this._formatMarkdown(parsed.monsters || 'Keine Monster.'),
      tacticsHtml: this._formatMarkdown(parsed.tactics || 'Keine Taktik.'),
      winConditionsHtml: this._formatMarkdown(parsed.winConditions || 'Keine Win Conditions.')
    };
  }

  _parseRawOutput(rawOutput) {
    const result = { title: '', scene: '', monsters: '', tactics: '', winConditions: '', xpTotal: 0 };
    if (!rawOutput) return result;

    // More robust parsing using section numbers and names
    // Pattern: ## 0. Titel, ## 1. Szene, ## 2. Monster, ## 3. Taktik, ## 4. Win Conditions
    const sectionPatterns = [
      { key: 'title', pattern: /#{1,3}\s*0\.?\s*titel/i },
      { key: 'scene', pattern: /#{1,3}\s*1\.?\s*szene/i },
      { key: 'monsters', pattern: /#{1,3}\s*2\.?\s*monster/i },
      { key: 'tactics', pattern: /#{1,3}\s*3\.?\s*taktik/i },
      { key: 'winConditions', pattern: /#{1,3}\s*4\.?\s*win\s*conditions/i }
    ];

    // Find all section start positions
    const positions = [];
    for (const { key, pattern } of sectionPatterns) {
      const match = rawOutput.match(pattern);
      if (match) {
        positions.push({ key, index: match.index, matchLength: match[0].length });
      }
    }

    // Sort by position
    positions.sort((a, b) => a.index - b.index);

    // Extract content between sections
    for (let i = 0; i < positions.length; i++) {
      const current = positions[i];
      const nextIndex = i + 1 < positions.length ? positions[i + 1].index : rawOutput.length;
      const content = rawOutput.substring(current.index + current.matchLength, nextIndex).trim();
      result[current.key] = content;

      // Extract XP from monster section
      if (current.key === 'monsters') {
        const xpMatch = content.match(/gesamt-xp[:\s]*(\d+)/i);
        if (xpMatch) result.xpTotal = parseInt(xpMatch[1]);
      }
    }

    // Fallback: if numbered sections not found, try keyword-based parsing
    if (!result.scene && !result.monsters && !result.tactics && !result.winConditions) {
      console.log('Encounter Builder | Falling back to keyword-based parsing');
      const sections = rawOutput.split(/(?=#{1,3}\s+(?:Szene|Monster|Taktik|Win\s*Conditions))/i);
      for (const section of sections) {
        const lower = section.toLowerCase();
        const cleanSection = section.replace(/^#{1,3}\s+\d*\.?\s*\w+[^\n]*\n?/i, '').trim();
        if (lower.match(/^#{1,3}\s+\d*\.?\s*szene/i)) {
          result.scene = cleanSection;
        } else if (lower.match(/^#{1,3}\s+\d*\.?\s*monster/i)) {
          result.monsters = cleanSection;
          const xpMatch = section.match(/gesamt-xp[:\s]*(\d+)/i);
          if (xpMatch) result.xpTotal = parseInt(xpMatch[1]);
        } else if (lower.match(/^#{1,3}\s+\d*\.?\s*taktik/i)) {
          result.tactics = cleanSection;
        } else if (lower.match(/^#{1,3}\s+\d*\.?\s*win\s*conditions/i)) {
          result.winConditions = cleanSection;
        }
      }
    }

    console.log('Encounter Builder | Parsed sections:', {
      scene: result.scene?.substring(0, 50) + '...',
      monsters: result.monsters?.substring(0, 50) + '...',
      tactics: result.tactics?.substring(0, 50) + '...',
      winConditions: result.winConditions?.substring(0, 50) + '...'
    });

    return result;
  }

  _formatMarkdown(text) {
    if (!text) return '';

    // First, handle tables
    const lines = text.split('\n');
    let html = '';
    let inTable = false;
    let tableRows = [];

    for (const line of lines) {
      // Check if this is a table row (starts with |)
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        // Skip separator rows (|---|---|)
        if (line.match(/^\|[\s-:|]+\|$/)) continue;

        if (!inTable) {
          inTable = true;
          tableRows = [];
        }
        tableRows.push(line);
      } else {
        // End of table, render it
        if (inTable && tableRows.length > 0) {
          html += this._renderTable(tableRows);
          tableRows = [];
          inTable = false;
        }
        // Regular line
        html += line + '\n';
      }
    }

    // Handle table at end of text
    if (inTable && tableRows.length > 0) {
      html += this._renderTable(tableRows);
    }

    // Now format the rest
    html = html
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/^[-*]\s+(.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br>');
    html = html.replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>');
    // Clean up empty paragraphs and excess breaks
    html = html.replace(/<br><br>/g, '</p><p>');
    html = html.replace(/<p><\/p>/g, '');
    if (!html.startsWith('<')) html = `<p>${html}</p>`;
    return html;
  }

  _renderTable(rows) {
    if (rows.length === 0) return '';

    let html = '<table class="monster-table"><thead><tr>';

    // First row is header
    const headerCells = rows[0].split('|').filter(c => c.trim());
    for (const cell of headerCells) {
      html += `<th>${cell.trim()}</th>`;
    }
    html += '</tr></thead><tbody>';

    // Rest are data rows
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].split('|').filter(c => c.trim());
      html += '<tr>';
      for (const cell of cells) {
        html += `<td>${cell.trim()}</td>`;
      }
      html += '</tr>';
    }

    html += '</tbody></table>';
    return html;
  }

  static async saveAsJournal() {
    const encounter = outputApp?.encounter;
    if (!encounter) { ui.notifications.warn('No encounter'); return; }
    try {
      const journal = await JournalEntry.create({
        name: `Combat - ${new Date().toLocaleDateString('de-DE')}`,
        pages: [{ name: 'Encounter', type: 'text', text: { content: encounter.rawOutput || '', format: CONST.JOURNAL_ENTRY_PAGE_FORMATS.MARKDOWN } }]
      });
      ui.notifications.info(`Journal "${journal.name}" created!`);
    } catch (e) { ui.notifications.error('Journal save failed'); }
  }

  static async regenerate() {
    const req = outputApp?.requestData;
    if (!req) { ui.notifications.warn('No request data'); return; }
    ui.notifications.info('Regenerating...');
    try {
      const enc = await generateSimpleCombat(req);
      if (outputApp) { outputApp.encounter = enc; game.settings.set(MODULE_ID, 'lastEncounter', enc); outputApp.render(true); }
    } catch (e) { ui.notifications.error(`Failed: ${e.message}`); }
  }

  static async backToBuilder() {
    if (outputApp) { outputApp.close(); outputApp = null; }
    openEncounterInput();
  }
}


// ============================================================================
// API: Generate Simple Combat
// ============================================================================

async function generateSimpleCombat(request) {
  const serverUrl = game.settings.get(MODULE_ID, 'serverUrl');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${serverUrl}/api/generate-combat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) throw new Error(`Server error: ${response.status}`);
    const data = await response.json();
    if (!data.success) throw new Error(data.error || 'Unknown error');
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') throw new Error('Request timed out');
    throw error;
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
