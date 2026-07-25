// ╔════════════════════════════════════════════════════════════════╗
// ║  vp-studio-tools.js — Asset Studio tools for the model        ║
// ║                                                                ║
// ║  Tools that let the model configure Prompt Node, set up         ║
// ║  reference images, create prompt tabs, and prepare the          ║
// ║  workflow for batch generation.                                ║
// ║                                                                ║
// ║  Load order: AFTER projector-asset-studio.js,                   ║
// ║              BEFORE vp-core-tools/projector-session.js.          ║
// ╚════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.tools) {
        console.error('[VP Studio Tools] VPTools registry not found. Load vp-tools.js first.');
        return;
    }

    const Tools = VP.tools;
    const S = VP.state;
    const VP_AS = window.VP_AS;

    if (!VP_AS || !VP_AS.Graph) {
        console.error('[VP Studio Tools] Asset Studio graph not found. Load projector-asset-studio.js first.');
        return;
    }

    const Graph = VP_AS.Graph;
    const uid = VP_AS.utils?.uid || ((prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);
    const clone = (x) => JSON.parse(JSON.stringify(x));

    // ════════════════════════════════════════════════════════════════
    //  HELPERS
    // ════════════════════════════════════════════════════════════════

    function graphIsLive() {
        return !!(Graph && Graph.canvas && Graph.world && Graph.links && Graph.viewport);
    }

    function emptyGraphState() {
        return {
            nodes: [],
            links: [],
            nextPos: { x: 40, y: 40 },
            viewport: { x: 0, y: 0, scale: 1, canvasW: 0, canvasH: 0 },
        };
    }

    function getGraphState() {
        try {
            if (graphIsLive()) return clone(Graph.serialize());
        } catch (err) {
            console.warn('[VP Studio Tools] Failed to serialize live graph:', err);
        }
        const fromState = S.assetStudio?.graph || null;
        if (fromState && typeof fromState === 'object') return clone(fromState);
        return emptyGraphState();
    }

    function makeNode(type, x, y, data = {}) {
        const heights = { loader: 260, lora: 260, prompt: 360, sampler: 220, output: 260 };
        return {
            type,
            id: uid(`node_${type}`),
            x,
            y,
            width: 240,
            height: heights[type] || 240,
            data: clone(data),
        };
    }

    function makeMinimalPipeline(promptData) {
        const loader = makeNode('loader', 40, 40);
        const lora = makeNode('lora', 300, 40);
        const prompt = makeNode('prompt', 560, 40, promptData);
        const sampler = makeNode('sampler', 820, 40);
        const output = makeNode('output', 1080, 40);
        return {
            nodes: [loader, lora, prompt, sampler, output],
            links: [
                { fromNode: loader.id, fromSocket: 'out', toNode: lora.id, toSocket: 'in' },
                { fromNode: lora.id, fromSocket: 'out', toNode: prompt.id, toSocket: 'in' },
                { fromNode: prompt.id, fromSocket: 'out', toNode: sampler.id, toSocket: 'in' },
                { fromNode: sampler.id, fromSocket: 'out', toNode: output.id, toSocket: 'in' },
            ],
            nextPos: { x: 40, y: 120 },
            viewport: { x: 0, y: 0, scale: 1, canvasW: 0, canvasH: 0 },
        };
    }

    function configurePromptNodeInGraph(graphState, promptData, outputData = {}) {
        if (!graphState || !Array.isArray(graphState.nodes)) graphState = emptyGraphState();
        if (!Array.isArray(graphState.links)) graphState.links = [];

        if (!graphState.nodes.length) return makeMinimalPipeline(promptData);

        // Find the active/main prompt node (one that actually has connections, or just the first one)
        let oldPrompt = graphState.nodes.find(n => n.type === 'prompt' && graphState.links.some(l => l.fromNode === n.id || l.toNode === n.id));
        if (!oldPrompt) oldPrompt = graphState.nodes.find(n => n.type === 'prompt');

        let newX = 560;
        let newY = 40;

        if (oldPrompt) {
            newX = oldPrompt.x;
            newY = oldPrompt.y;
            // Shift the old prompt down so it is preserved but visually out of the main flow
            oldPrompt.y += 380;
        }

        // Always create a new prompt node to prevent data loss of user's custom variants
        let newPrompt = makeNode('prompt', newX, newY, promptData);
        delete newPrompt.data.positive;
        delete newPrompt.data.negative;
        graphState.nodes.push(newPrompt);

        if (oldPrompt) {
            // Re-wire the graph: steal connections from the old prompt and give them to the new one
            graphState.links.forEach(link => {
                if (link.toNode === oldPrompt.id) link.toNode = newPrompt.id;
                if (link.fromNode === oldPrompt.id) link.fromNode = newPrompt.id;
            });
        } else {
            // No previous prompt existed at all, wire up heuristically
            const sampler = graphState.nodes.find(n => n.type === 'sampler');
            const lora = graphState.nodes.find(n => n.type === 'lora');
            const loader = graphState.nodes.find(n => n.type === 'loader');
            const source = lora || loader || null;
            if (source) graphState.links.push({ fromNode: source.id, fromSocket: 'out', toNode: newPrompt.id, toSocket: 'in' });
            if (sampler) graphState.links.push({ fromNode: newPrompt.id, fromSocket: 'out', toNode: sampler.id, toSocket: 'in' });
        }

        if (outputData && Object.keys(outputData).length) {
            let output = graphState.nodes.find(n => n.type === 'output');
            if (output) {
                output.data = { ...(output.data || {}), ...outputData };
            }
        }

        return graphState;
    }

    function ensureGalleryData() {
        if (!S.galleryData || typeof S.galleryData !== 'object') {
            S.galleryData = { categories: [], tabs: [], activeTabId: null, tagAliases: {} };
        }
        if (!Array.isArray(S.galleryData.categories)) S.galleryData.categories = [];
        if (!Array.isArray(S.galleryData.tabs)) S.galleryData.tabs = [];
        if (!S.galleryData.tagAliases) S.galleryData.tagAliases = {};
        return S.galleryData;
    }

    function findByName(list, name) {
        const needle = String(name || '').trim().toLowerCase();
        if (!needle) return null;
        return (list || []).find(x => String(x.name || '').trim().toLowerCase() === needle) || null;
    }

    function ensureGalleryDestination(galleryTabName, galleryCategoryName = null) {
        const tabName = String(galleryTabName || '').trim();
        if (!tabName) return null;
        const gd = ensureGalleryData();

        let tab = findByName(gd.tabs, tabName);
        if (tab) return tab;

        let category = galleryCategoryName ? findByName(gd.categories, galleryCategoryName) : null;
        if (!category && gd.categories.length) category = gd.categories[0];
        if (!category) {
            category = {
                id: uid('cat'),
                name: String(galleryCategoryName || 'Studio').trim() || 'Studio',
                desc: 'Auto-created by Asset Studio tool',
                state: 'open',
            };
            gd.categories.push(category);
        }

        tab = {
            id: uid('tab'),
            categoryId: category.id,
            name: tabName,
            desc: 'Auto-created for model-driven asset generation',
            state: 'open',
        };
        gd.tabs.push(tab);
        return tab;
    }

    async function persistGalleryData() {
        try { VP.gallery?.TabsManager?.renderSidebar?.(); } catch {}
        try { VP.gallery?.renderGalleryGrid?.(); } catch {}
        const DB = window.VP_DB;
        if (DB?.setGalleryData) {
            try { await DB.setGalleryData(S.galleryData); } catch (err) { console.warn('[VP Studio Tools] gallery persist failed:', err); }
        }
    }

    async function persistAssetStudioState() {
        VP.assetStudio?.ensureStudioState?.();
        if (VP.assetStudio?.sanitizeStudioStateReferences) VP.assetStudio.sanitizeStudioStateReferences(S.assetStudio);
        const DB = window.VP_DB;
        if (DB?.setAssetStudioState) {
            await DB.setAssetStudioState(S.assetStudio);
            return;
        }
        if (graphIsLive() && VP.assetStudio?.saveStudioState) {
            VP.assetStudio.saveStudioState({ immediate: true });
        }
    }

    function applyGraphState(graphState) {
        S.assetStudio = S.assetStudio || {};
        S.assetStudio.graph = clone(graphState);
        if (graphIsLive()) {
            try {
                Graph.deserialize(clone(graphState));
                Graph.viewport?.frameNodes?.(Array.from(Graph.nodes.values()));
                Graph.links?._render?.();
            } catch (err) {
                console.warn('[VP Studio Tools] Failed to apply graph to live canvas:', err);
            }
        }
    }

    function normalizeTabs(inputTabs) {
        const out = [];
        for (const t of inputTabs || []) {
            const name = String(t?.name || '').trim() || 'variant';
            const text = String(t?.text || '').trim();
            if (!text) continue;
            out.push({ id: uid('tab'), name, text });
        }
        return out;
    }

    // ════════════════════════════════════════════════════════════════
    //  TOOL: configure_prompt_studio
    // ════════════════════════════════════════════════════════════════

    Tools.register({
        name: 'configure_prompt_studio',
        icon: '🎨',
        group: 'studio',
        description: `Configure Asset Studio's Prompt Node for batch asset generation.
Use this after the user approves an asset pack plan: emotions, poses, outfits, backgrounds, etc.

IMPORTANT:
- Use existing gallery tags in referenceTags. Do not invent reference tags.
- Do not embed images or file paths.
- Create one variant per generated asset.
- Every variant prompt should start with {name:snake_case_gallery_tag}.
- galleryTabName is the single Gallery destination tab for ALL generated assets in this pack.

After calling this, tell the user: "Workflow ready! Open Asset Studio, check the workflow, then press ▶▶ Produce All."`,
        schema: {
            type: 'object',
            properties: {
                referenceTags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Existing gallery asset tags to use as visual references, e.g. ["emily_default"].',
                    minItems: 1,
                    maxItems: 3,
                },
                variants: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Short variant name, e.g. "smile", "angry", "standing".' },
                            text: { type: 'string', description: 'Full prompt. Start with {name:tag}. Example: "{name:emily_smile} same character as reference, warm smile..."' },
                        },
                        required: ['name', 'text'],
                    },
                    description: 'Prompt variations. Each Prompt Node variant generates one image.',
                    minItems: 1,
                },
                galleryTabName: {
                    type: 'string',
                    description: 'Destination Gallery tab for all generated assets in this pack, e.g. "Emily Emotions". Created if missing.',
                },
                galleryCategoryName: {
                    type: 'string',
                    description: 'Optional destination Gallery category, e.g. "Characters". If omitted, the first existing category is used, or Studio is created.',
                },
            },
            required: ['referenceTags', 'variants'],
        },
        lifecycle: 'ephemeral',
        source: 'studio',
        summarize(res) {
            return `Studio: ${res.variantCount} variant(s), ${res.referenceCount} ref(s), output: ${res.galleryTabName || 'active gallery tab'}`;
        },
        handler: async (args) => {
            const referenceTags = (Array.isArray(args.referenceTags) ? args.referenceTags : [])
                .map(x => String(x || '').trim())
                .filter(Boolean)
                .slice(0, 3);
            const newVariants = normalizeTabs(Array.isArray(args.variants) ? args.variants : (Array.isArray(args.tabs) ? args.tabs : []));
            const galleryTabName = String(args.galleryTabName || '').trim() || null;
            const galleryCategoryName = String(args.galleryCategoryName || '').trim() || null;

            if (!newVariants.length) return { ok: false, error: 'Need at least one non-empty prompt variant.' };
            if (!referenceTags.length) return { ok: false, error: 'Need at least one reference tag from the gallery.' };

            for (const tag of referenceTags) {
                if (!S?.gallery?.has?.(tag)) {
                    return { ok: false, error: `Gallery tag "${tag}" not found. Use gallery_search first.` };
                }
            }

            // Make sure async Asset Studio state load doesn't overwrite the tool result.
            if (VP.assetStudio?._stateLoadPromise) {
                try { await VP.assetStudio._stateLoadPromise; } catch {}
            }

            let destination = null;
            if (galleryTabName) {
                destination = ensureGalleryDestination(galleryTabName, galleryCategoryName);
                if (destination) {
                    S.galleryData.activeTabId = destination.id;
                    S.ui.lastAssetTabId = destination.id;
                    await persistGalleryData();
                }
            }

            VP.assetStudio?.ensureStudioState?.();
            S.assetStudio = S.assetStudio || {};
            if (destination) {
                S.assetStudio.outputTabId = destination.id;
                S.assetStudio.outputTabName = destination.name;
                S.assetStudio.outputCategoryName = galleryCategoryName || null;
            }

            const promptData = {
                reference: referenceTags.map(tag => ({ type: 'gallery', tag })),
                variants: newVariants,
                activeVariantId: newVariants[0].id,
            };

            const outputData = destination ? { galleryTabId: destination.id } : {};

            const graphState = configurePromptNodeInGraph(getGraphState(), promptData, outputData);
            applyGraphState(graphState);
            await persistAssetStudioState();

            VP.showToast?.(
                `Prompt Node configured: ${newVariants.length} variant(s), ${referenceTags.length} ref(s)${destination ? ` → ${destination.name}` : ''}`,
                'success'
            );

            return {
                ok: true,
                variantCount: newVariants.length,
                referenceCount: referenceTags.length,
                referenceTags,
                galleryTabName: destination?.name || galleryTabName,
                galleryTabId: destination?.id || null,
                galleryCategoryName,
                graphAppliedToLiveCanvas: graphIsLive(),
                variants: newVariants.map(v => ({ name: v.name })),
            };
        },
    });

    console.log('[VP Studio Tools] registered: configure_prompt_studio');
})();
