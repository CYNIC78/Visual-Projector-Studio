// ╔════════════════════════════════════════════════════════════════╗
// ║  vp-studio-tools.js — Asset Studio tools for the model        ║
// ║                                                                ║
// ║  Tools that let the model configure Prompt Node, set up         ║
// ║  reference images, create prompt tabs, and prepare the          ║
// ║  workflow for batch generation.                                ║
// ║                                                                ║
// ║  Load order: AFTER projector-asset-studio.js,                   ║
// ║              BEFORE projector-session.js.                       ║
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
    const NodeRegistry = VP_AS.NodeRegistry;

    // ════════════════════════════════════════════════════════════════
    //  HELPERS
    // ════════════════════════════════════════════════════════════════

    /** Find the first prompt node in the graph, or create one */
    function findOrCreatePromptNode() {
        const existing = Array.from(Graph.nodes.values()).find(n => n.type === 'prompt');
        if (existing) return existing;

        // If graph is empty, build a minimal T2I pipeline first
        if (Graph.nodes.size === 0) {
            const loader = Graph.addNode('loader', 40, 40);
            const lora = Graph.addNode('lora', 300, 40);
            const prompt = Graph.addNode('prompt', 560, 40);
            const sampler = Graph.addNode('sampler', 820, 40);
            const output = Graph.addNode('output', 1080, 40);

            Graph.links.add({ fromNode: loader.id, fromSocket: 'out', toNode: lora.id, toSocket: 'in' });
            Graph.links.add({ fromNode: lora.id, fromSocket: 'out', toNode: prompt.id, toSocket: 'in' });
            Graph.links.add({ fromNode: prompt.id, fromSocket: 'out', toNode: sampler.id, toSocket: 'in' });
            Graph.links.add({ fromNode: sampler.id, fromSocket: 'out', toNode: output.id, toSocket: 'in' });

            Graph.viewport.frameNodes(Array.from(Graph.nodes.values()));
            return prompt;
        }

        // There are nodes but no prompt — add one and wire it
        const sampler = Array.from(Graph.nodes.values()).find(n => n.type === 'sampler');
        const prompt = Graph.addNode('prompt', 560, 40);

        if (sampler) {
            // Try to find lora or the node before sampler
            const lora = Array.from(Graph.nodes.values()).find(n => n.type === 'lora');
            const source = lora || Array.from(Graph.nodes.values()).find(n => n.type === 'loader');
            if (source) {
                Graph.links.add({ fromNode: source.id, fromSocket: 'out', toNode: prompt.id, toSocket: 'in' });
            }
            Graph.links.add({ fromNode: prompt.id, fromSocket: 'out', toNode: sampler.id, toSocket: 'in' });
        }

        return prompt;
    }

    /** Convert a gallery asset tag to a base64 data URL for persistence */
    async function assetTagToBase64(tag) {
        const asset = S?.gallery?.get(tag);
        if (!asset) return null;

        if (asset.base64 && asset.base64.startsWith('data:image/')) {
            return asset.base64;
        }
        if (asset.blob && typeof VP.blobToBase64 === 'function') {
            try { return await VP.blobToBase64(asset.blob); } catch {}
        }
        if (asset.url && asset.url.startsWith('data:')) {
            return asset.url;
        }
        return null;
    }

    // ════════════════════════════════════════════════════════════════
    //  TOOL: configure_prompt_studio
    // ════════════════════════════════════════════════════════════════

    Tools.register({
        name: 'configure_prompt_studio',
        icon: '🎨',
        group: 'studio',
        description: `Configure the Asset Studio's Prompt Node for batch asset generation.
Use this when the user wants to create variations of an image — emotions, poses, outfits, backgrounds, etc.

ACCEPTS:
- referenceTags: array of gallery asset tags to use as visual references (1-3 images)
- tabs: array of prompt variations, each with a name and prompt text
- galleryTabName: (optional) name of the gallery tab to receive generated assets

Each tab generates one output image. Use {name:tag_name} in the prompt text
to set the asset's gallery tag. Example: "{name:emily_smile} Make her smile."

After calling this, tell the user the workflow is ready:
"Workflow ready! Open Asset Studio and press ▶▶ Produce All to generate."`,
        schema: {
            type: 'object',
            properties: {
                referenceTags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Gallery asset tags to use as visual references (1-3 images). Examples: ["emily"], ["character", "bedroom"], ["person", "outfit", "location"].',
                    maxItems: 3,
                },
                tabs: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Short tab name for display, e.g. "smile", "angry", "standing".' },
                            text: { type: 'string', description: 'Full prompt with optional {name:tag} command. E.g. "{name:emily_smile} Make the character smile broadly. Keep all features, lighting and background intact."' },
                        },
                        required: ['name', 'text'],
                    },
                    description: 'Array of prompt variations. Each will become a tab in the Prompt Node.',
                },
                galleryTabName: {
                    type: 'string',
                    description: 'Optional name for a gallery tab to organize generated assets. If it exists, assets go there. If not, a new tab is created.',
                },
            },
            required: ['referenceTags', 'tabs'],
        },
        lifecycle: 'ephemeral',
        source: 'studio',
        summarize(res) {
            return `Studio: ${res.tabCount} tab(s), ${res.referenceCount} reference(s), gallery tab: ${res.galleryTabName || 'current active tab'}`;
        },
        handler: async (args) => {
            const referenceTags = Array.isArray(args.referenceTags) ? args.referenceTags : [];
            const tabs = Array.isArray(args.tabs) ? args.tabs : [];
            const galleryTabName = String(args.galleryTabName || '').trim() || null;

            if (tabs.length === 0) {
                return { ok: false, error: 'Need at least one tab with name and text.' };
            }
            if (referenceTags.length === 0) {
                return { ok: false, error: 'Need at least one reference tag from the gallery.' };
            }

            // 1. Verify gallery tags exist and convert to base64
            const refResults = [];
            for (const tag of referenceTags) {
                const asset = S?.gallery?.get(tag);
                if (!asset) {
                    return { ok: false, error: `Gallery tag "${tag}" not found. Available: user's gallery.` };
                }
                const b64 = await assetTagToBase64(tag);
                if (!b64) {
                    return { ok: false, error: `Cannot read image data for "${tag}".` };
                }
                refResults.push(b64);
            }

            // 2. Find or create prompt node
            const promptNode = findOrCreatePromptNode();
            if (!promptNode) {
                return { ok: false, error: 'Cannot find or create prompt node in the graph.' };
            }

            // 3. Set references
            promptNode.data.reference = refResults;

            // 4. Create tabs
            const newTabs = tabs.map(t => ({
                id: VP_AS.utils.uid('tab'),
                name: String(t.name || '').trim() || 'variant',
                text: String(t.text || '').trim() || '',
            }));
            promptNode.data.tabs = newTabs;
            promptNode.data.activeTabId = newTabs[0].id;

            // 5. Clean up old data that might interfere
            delete promptNode.data.positive;
            delete promptNode.data.negative;

            // 6. Handle gallery tab
            let galleryTabId = null;
            if (galleryTabName) {
                // Check if tab exists in gallery
                const existing = S?.galleryData?.tabs?.find(t =>
                    t.name.toLowerCase() === galleryTabName.toLowerCase()
                );
                if (existing) {
                    galleryTabId = existing.id;
                } else {
                    // Create new tab in the first category
                    const cats = S?.galleryData?.categories || [];
                    let catId = cats.length > 0 ? cats[0].id : null;
                    if (!catId && S?.galleryData) {
                        catId = 'cat_' + Date.now();
                        S.galleryData.categories.push({ id: catId, name: 'Studio', desc: '', state: 'open' });
                    }
                    if (catId && S?.galleryData) {
                        galleryTabId = 'tab_' + Date.now() + Math.random().toString(36).substr(2, 3);
                        S.galleryData.tabs.push({
                            id: galleryTabId,
                            categoryId: catId,
                            name: galleryTabName,
                            desc: 'Auto-created for asset generation',
                            state: 'open',
                        });
                        // Set as active for receiving new assets
                        S.galleryData.activeTabId = galleryTabId;
                        S.ui.lastAssetTabId = galleryTabId;
                        if (VP.gallery?.TabsManager?.renderSidebar) {
                            VP.gallery.TabsManager.renderSidebar();
                        }
                        const DB = window.VP_DB;
                        if (DB?.setGalleryData) DB.setGalleryData(S.galleryData);
                    }
                }
            }

            // 7. Persist everything
            Graph.persist();

            // 8. Notify user via toast
            VP.showToast?.(
                `Prompt Node configured: ${newTabs.length} tab(s), ${referenceTags.length} reference(s)`,
                'success'
            );

            return {
                ok: true,
                tabCount: newTabs.length,
                referenceCount: refResults.length,
                galleryTabName,
                promptNodeId: promptNode.id,
                tabs: newTabs.map(t => ({ name: t.name })),
            };
        },
    });

    console.log('[VP Studio Tools] registered: configure_prompt_studio');

})();
