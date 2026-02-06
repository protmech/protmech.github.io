// State
let activationData = {};  // [layer][position] -> array of {value, latentIdx}
let topActivationsData = null;  // Top activations per layer/latent from JSON
let virtualWeightsData = null;  // Virtual weights edges from JSON
let sequence = '';
let canvasNodes = [];      // {id, x, y, latentIdx, layer, pos, aa, isSuper, children}
let edges = [];            // {id, from, to}
let selectedNodes = new Set();
let selectedEdges = new Set();
let nodeIdCounter = 0;
let edgeIdCounter = 0;
let dragState = null;
let virtualWeightsVisible = false;  // Toggle state for virtual weights
let virtualWeightsEdges = [];       // Edges created from virtual weights
let aggregatedVirtualWeights = new Map();  // Averaged weights by (layer, latent) pairs
let virtualWeightsThreshold = 10;  // Show top x% of edges by absolute magnitude
let gridEdgeTooltip = null;  // Tooltip for virtual weight edges

// File upload state
let uploadedFiles = {
    activationIndices: null,
    seq: null,
    topActivations: null,
    virtualWeights: null  // Optional
};

// Upload screen elements
const uploadScreen = document.getElementById('upload-screen');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const btnLoad = document.getElementById('btn-load');
const statusActivation = document.getElementById('status-activation');
const statusSeq = document.getElementById('status-seq');
const statusTop = document.getElementById('status-top');
const statusVirtual = document.getElementById('status-virtual');
const appContainer = document.getElementById('app');

// Example selector elements
const exampleDropdown = document.getElementById('example-dropdown');
const btnLoadCustom = document.getElementById('btn-load-custom');
let examplesData = [];  // Store loaded examples

// Load examples from CSV on page load
async function loadExamplesCSV() {
    try {
        const response = await fetch('examples/examples.csv');
        const csvText = await response.text();
        const lines = csvText.trim().split('\n');

        // Skip header row
        const examples = [];
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // Parse CSV line (handle quoted values)
            const match = line.match(/(\d+),\s*"([^"]+)",\s*"([^"]+)"/);
            if (match) {
                examples.push({
                    id: match[1],
                    name: match[2],
                    path: match[3]
                });
            }
        }

        // Fetch sequence for each example to build the dropdown label
        for (const example of examples) {
            try {
                const seqResponse = await fetch(example.path + 'seq.txt');
                const seqText = await seqResponse.text();
                example.sequence = seqText.trim();
            } catch (err) {
                example.sequence = '';
            }
        }

        examplesData = examples;
        populateExampleDropdown(examples);

        // Auto-load first example
        if (examples.length > 0) {
            exampleDropdown.value = examples[0].path;
            await loadExampleData(examples[0].path);
        }
    } catch (err) {
        console.error('Error loading examples CSV:', err);
        exampleDropdown.innerHTML = '<option value="">No examples available</option>';
    }
}

// Populate dropdown with examples
function populateExampleDropdown(examples) {
    exampleDropdown.innerHTML = '<option value="">Select an example circuit...</option>';

    for (const example of examples) {
        const option = document.createElement('option');
        option.value = example.path;

        // Format: [Circuit name] - [Sequence (max 15 chars)]...
        let seqDisplay = example.sequence || '';
        if (seqDisplay.length > 15) {
            seqDisplay = seqDisplay.substring(0, 15) + '...';
        }
        option.textContent = `${example.name} - ${seqDisplay}`;

        exampleDropdown.appendChild(option);
    }
}

// Load example data from path
async function loadExampleData(path) {
    try {
        // Reset state
        resetAppState();

        // Fetch all required files
        const [activationsText, seqText, topActivationsText, virtualWeightsText, canvasStateText] = await Promise.all([
            fetch(path + 'activation_indices.json').then(r => r.text()),
            fetch(path + 'seq.txt').then(r => r.text()),
            fetch(path + 'top_activations.json').then(r => r.text()),
            fetch(path + 'virtual_weights.json').then(r => r.ok ? r.text() : null).catch(() => null),
            fetch(path + 'canvas-state.json').then(r => r.ok ? r.text() : null).catch(() => null)
        ]);

        const activations = JSON.parse(activationsText);
        sequence = seqText.trim();
        topActivationsData = JSON.parse(topActivationsText);

        // Parse virtual weights if present
        if (virtualWeightsText) {
            virtualWeightsData = JSON.parse(virtualWeightsText);
            preprocessVirtualWeights();
            const btnVirtualWeights = document.getElementById('btn-virtual-weights');
            if (btnVirtualWeights) {
                btnVirtualWeights.disabled = false;
            }
            // Set default threshold to cap at 1000 edges max
            const maxEdges = 1000;
            const totalEdges = virtualWeightsData.length;
            if (totalEdges > maxEdges) {
                virtualWeightsThreshold = (maxEdges / totalEdges * 100);
            } else {
                virtualWeightsThreshold = 100;
            }
            const edgeSlider = document.getElementById('edge-threshold-slider');
            const edgeInput = document.getElementById('edge-threshold-input');
            if (edgeSlider) edgeSlider.value = virtualWeightsThreshold;
            if (edgeInput) edgeInput.value = virtualWeightsThreshold;
        } else {
            virtualWeightsData = null;
            const btnVirtualWeights = document.getElementById('btn-virtual-weights');
            if (btnVirtualWeights) {
                btnVirtualWeights.disabled = true;
            }
        }

        // Index by layer and position
        for (const [layer, pos, value, latentIdx] of activations) {
            if (!activationData[layer]) activationData[layer] = {};
            if (!activationData[layer][pos]) activationData[layer][pos] = [];
            activationData[layer][pos].push({ value, latentIdx });
        }

        // Render the visualization
        renderGrid();
        renderSequence();
        updateLegend();

        // Show virtual weights by default if data is available
        if (virtualWeightsData) {
            virtualWeightsVisible = true;
            const btn = document.getElementById('btn-virtual-weights');
            if (btn) {
                btn.classList.add('active');
                btn.innerHTML = '<span class="btn-icon">👁</span> Hide virtual weights';
            }
            renderVirtualWeightsInGrid();
        }

        // Load canvas state if available
        if (canvasStateText) {
            loadCanvasState(canvasStateText);
        }

    } catch (err) {
        console.error('Error loading example data:', err);
        alert('Error loading example. Please try another or load a custom circuit.');
    }
}

// Reset app state for fresh data load
function resetAppState() {
    activationData = {};
    topActivationsData = null;
    virtualWeightsData = null;
    sequence = '';
    canvasNodes = [];
    edges = [];
    selectedNodes.clear();
    selectedEdges.clear();
    nodeIdCounter = 0;
    edgeIdCounter = 0;
    virtualWeightsVisible = false;
    virtualWeightsEdges = [];
    aggregatedVirtualWeights.clear();

    // Clear canvas
    const nodesContainer = document.getElementById('nodes-container');
    const edgesSvg = document.getElementById('edges-svg');
    if (nodesContainer) nodesContainer.innerHTML = '';
    if (edgesSvg) edgesSvg.innerHTML = '';

    // Reset virtual weights button state
    const btnVirtualWeights = document.getElementById('btn-virtual-weights');
    if (btnVirtualWeights) {
        btnVirtualWeights.classList.remove('active');
    }

    // // Hide edge filter control
    // const edgeFilterControl = document.getElementById('edge-filter-control');
    // if (edgeFilterControl) {
    //     edgeFilterControl.classList.add('hidden');
    // }
}

// Handle dropdown change
exampleDropdown.addEventListener('change', async (e) => {
    const path = e.target.value;
    if (path) {
        await loadExampleData(path);
    }
});

// Handle "Load Custom Circuit" button
btnLoadCustom.addEventListener('click', () => {
    // Reset file upload state
    uploadedFiles = {
        activationIndices: null,
        seq: null,
        topActivations: null,
        virtualWeights: null
    };

    // Reset status indicators
    statusActivation.classList.remove('loaded');
    statusActivation.querySelector('.status-icon').textContent = '○';
    statusSeq.classList.remove('loaded');
    statusSeq.querySelector('.status-icon').textContent = '○';
    statusTop.classList.remove('loaded');
    statusTop.querySelector('.status-icon').textContent = '○';
    statusVirtual.classList.remove('loaded');
    statusVirtual.querySelector('.status-icon').textContent = '○';

    // Reset button
    btnLoad.textContent = 'Load Data';
    btnLoad.disabled = true;

    // Show upload screen
    uploadScreen.classList.remove('hidden');
});

// Initialize examples on page load
loadExamplesCSV();

// File upload handlers
dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
});

dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
});

dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
});

fileInput.addEventListener('change', (e) => {
    handleFiles(e.target.files);
});

function handleFiles(files) {
    for (const file of files) {
        const name = file.name.toLowerCase();

        if (name === 'activation_indices.json' || name.includes('activation_indices')) {
            uploadedFiles.activationIndices = file;
            statusActivation.classList.add('loaded');
            statusActivation.querySelector('.status-icon').textContent = '●';
        } else if (name === 'seq.txt' || name.includes('seq')) {
            uploadedFiles.seq = file;
            statusSeq.classList.add('loaded');
            statusSeq.querySelector('.status-icon').textContent = '●';
        } else if (name === 'top_activations.json' || name.includes('top_activations')) {
            uploadedFiles.topActivations = file;
            statusTop.classList.add('loaded');
            statusTop.querySelector('.status-icon').textContent = '●';
        } else if (name === 'virtual_weights.json' || name.includes('virtual_weights')) {
            uploadedFiles.virtualWeights = file;
            statusVirtual.classList.add('loaded');
            statusVirtual.querySelector('.status-icon').textContent = '●';
        }
    }

    updateLoadButton();
}

function updateLoadButton() {
    const allLoaded = uploadedFiles.activationIndices &&
                      uploadedFiles.seq &&
                      uploadedFiles.topActivations &&
                      uploadedFiles.virtualWeights;
    btnLoad.disabled = !allLoaded;
}

btnLoad.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btnLoad.disabled) return;

    try {
        btnLoad.textContent = 'Loading...';
        btnLoad.disabled = true;

        // Reset app state for fresh load
        resetAppState();

        // Clear dropdown selection (custom circuit)
        exampleDropdown.value = '';

        // Read all required files
        const filePromises = [
            uploadedFiles.activationIndices.text(),
            uploadedFiles.seq.text(),
            uploadedFiles.topActivations.text(),
            uploadedFiles.virtualWeights.text()
        ];

        const results = await Promise.all(filePromises);
        const [activationsText, seqText, topActivationsText] = results;

        const activations = JSON.parse(activationsText);
        sequence = seqText.trim();
        topActivationsData = JSON.parse(topActivationsText);

        // Parse virtual weights if present
        if (results[3]) {
            virtualWeightsData = JSON.parse(results[3]);
            // Precompute averaged weights by (layer, latent) pairs
            preprocessVirtualWeights();
            // Enable the virtual weights toggle button
            const btnVirtualWeights = document.getElementById('btn-virtual-weights');
            if (btnVirtualWeights) {
                btnVirtualWeights.disabled = false;
            }
            // Set default threshold to cap at 1000 edges max
            const maxEdges = 1000;
            const totalEdges = virtualWeightsData.length;
            if (totalEdges > maxEdges) {
                virtualWeightsThreshold = (maxEdges / totalEdges * 100);
            } else {
                virtualWeightsThreshold = 100;
            }
            // Update slider and input to reflect the calculated default
            const edgeSlider = document.getElementById('edge-threshold-slider');
            const edgeInput = document.getElementById('edge-threshold-input');
            if (edgeSlider) edgeSlider.value = virtualWeightsThreshold;
            if (edgeInput) edgeInput.value = virtualWeightsThreshold;
        }

        // Index by layer and position
        for (const [layer, pos, value, latentIdx] of activations) {
            if (!activationData[layer]) activationData[layer] = {};
            if (!activationData[layer][pos]) activationData[layer][pos] = [];
            activationData[layer][pos].push({ value, latentIdx });
        }

        // Hide upload screen
        uploadScreen.classList.add('hidden');

        // Render the visualization
        renderGrid();
        renderSequence();
        updateLegend();

        // Show virtual weights by default if data is available
        if (virtualWeightsData) {
            virtualWeightsVisible = true;
            const btn = document.getElementById('btn-virtual-weights');
            if (btn) {
                btn.classList.add('active');
                btn.innerHTML = '<span class="btn-icon">👁</span> Hide virtual weights';
            }
            renderVirtualWeightsInGrid();
        }

    } catch (err) {
        console.error('Error loading files:', err);
        alert('Error loading files. Please make sure all files are valid.');
        btnLoad.textContent = 'Load Data';
        updateLoadButton();
    }
});

// DOM Elements
const gridBody = document.getElementById('grid-body');
const sequenceBar = document.getElementById('sequence-bar');
const sequenceContent = document.getElementById('sequence-content');
const nodesContainer = document.getElementById('nodes-container');
const edgesSvg = document.getElementById('edges-svg');
const btnDelete = document.getElementById('btn-delete');
const activationPanel = document.getElementById('activation-panel');
const panelTitle = document.getElementById('panel-title');
const panelContent = document.getElementById('activation-panel-content');
const panelClose = document.getElementById('panel-close');

// Layer panel elements
const layerPanel = document.getElementById('layer-panel');
const layerPanelTitle = document.getElementById('layer-panel-title');
const layerPanelContent = document.getElementById('layer-panel-content');
const layerPanelClose = document.getElementById('layer-panel-close');

// Sync scroll between grid and sequence bar
let isSyncing = false;
gridBody.addEventListener('scroll', () => {
    if (isSyncing) return;
    isSyncing = true;
    sequenceBar.scrollLeft = gridBody.scrollLeft;
    isSyncing = false;
});
sequenceBar.addEventListener('scroll', () => {
    if (isSyncing) return;
    isSyncing = true;
    gridBody.scrollLeft = sequenceBar.scrollLeft;
    isSyncing = false;
});

// Color scale for activation values (light green #b8e994 to teal #079992)
function getActivationColor(value, minVal, maxVal) {
    const t = Math.max(0, Math.min(1, (value - minVal) / (maxVal - minVal)));

    // Light green to teal gradient
    const r = Math.round(184 - t * 177);  // 184 to 7
    const g = Math.round(233 - t * 80);   // 233 to 153
    const b = Math.round(148 - t * 2);    // 148 to 146
    return `rgb(${r}, ${g}, ${b})`;
}


// Find min/max activation values for color scaling
function getValueRange() {
    let min = Infinity, max = -Infinity;
    for (const layer in activationData) {
        for (const pos in activationData[layer]) {
            for (const item of activationData[layer][pos]) {
                min = Math.min(min, item.value);
                max = Math.max(max, item.value);
            }
        }
    }
    return { min, max };
}

// Update legend with actual min/max values
function updateLegend() {
    const { min, max } = getValueRange();
    const legendMin = document.querySelector('.legend-min');
    const legendMax = document.querySelector('.legend-max');
    if (legendMin) legendMin.textContent = min.toFixed(2);
    if (legendMax) legendMax.textContent = max.toFixed(2);
}

// Compute maximum latents per position across all layers
function computeColumnWidths() {
    const numPositions = sequence.length;
    const maxLatentsPerPos = new Array(numPositions).fill(0);

    for (let layer = 0; layer <= 5; layer++) {
        for (let pos = 0; pos < numPositions; pos++) {
            const items = activationData[layer]?.[pos] || [];
            maxLatentsPerPos[pos] = Math.max(maxLatentsPerPos[pos], items.length);
        }
    }
    return maxLatentsPerPos;
}

// Render grid - layers as rows, positions as columns
function renderGrid() {
    const { min, max } = getValueRange();
    const numPositions = sequence.length;
    const maxLatentsPerPos = computeColumnWidths();

    // Base width per latent box (larger boxes with 8px horizontal padding + 12px font)
    const boxWidth = 50;
    const minCellWidth = 55;
    const cellPaddingAndBorder = 21; // 20px padding (10px each side) + 1px border

    let html = '';
    // Each row is a layer (reversed: 5 to 0)
    for (let layer = 5; layer >= 0; layer--) {
        html += `<div class="grid-row" data-layer="${layer}">`;
        // Each column is a position
        for (let pos = 0; pos < numPositions; pos++) {
            const cellWidth = Math.max(minCellWidth, maxLatentsPerPos[pos] * boxWidth + cellPaddingAndBorder);
            html += `<div class="grid-cell" data-layer="${layer}" data-pos="${pos}" style="width: ${cellWidth}px; min-width: ${cellWidth}px;">`;
            const items = activationData[layer]?.[pos] || [];
            for (const item of items) {
                const color = getActivationColor(item.value, min, max);
                const t = (item.value - min) / (max - min);
                // Use black text for bright colors (cyan, green, yellow), white for dark (blue, red)
                const textColor = (t > 0.15 && t < 0.85) ? '#000' : '#fff';
                html += `<div class="latent-box"
                    data-layer="${layer}"
                    data-pos="${pos}"
                    data-latent="${item.latentIdx}"
                    data-value="${item.value.toFixed(2)}"
                    style="background: ${color}; color: ${textColor}"
                    title="L${item.latentIdx + 1} (${item.value.toFixed(2)})"
                >${item.latentIdx + 1}</div>`;
            }
            html += '</div>';
        }
        html += '</div>';
    }
    gridBody.innerHTML = html;

    // Store column widths for sequence bar
    window.columnWidths = maxLatentsPerPos.map(count => Math.max(minCellWidth, count * boxWidth + cellPaddingAndBorder));

    // Add click handlers
    gridBody.querySelectorAll('.latent-box').forEach(box => {
        box.addEventListener('click', handleLatentClick);
    });
}

// Render sequence bar
function renderSequence() {
    let html = '';
    const widths = window.columnWidths || [];
    for (let i = 0; i < sequence.length; i++) {
        const width = widths[i] || 36;
        html += `<div class="seq-item" data-pos="${i}" style="width: ${width}px; min-width: ${width}px;">
            <span class="seq-aa">${sequence[i]}</span>
            <span class="seq-pos">${i + 1}</span>
        </div>`;
    }
    sequenceContent.innerHTML = html;

    // Add click handlers to scroll grid horizontally
    sequenceContent.querySelectorAll('.seq-item').forEach(item => {
        item.addEventListener('click', () => {
            const pos = parseInt(item.dataset.pos);
            const cell = gridBody.querySelector(`.grid-cell[data-pos="${pos}"]`);
            if (cell) {
                cell.scrollIntoView({ behavior: 'smooth', inline: 'center' });
                // Highlight column briefly
                const cells = gridBody.querySelectorAll(`.grid-cell[data-pos="${pos}"]`);
                cells.forEach(c => c.style.background = 'rgba(0, 217, 255, 0.2)');
                setTimeout(() => cells.forEach(c => c.style.background = ''), 500);
            }
        });
    });
}

// Handle latent click - show activation panel
function handleLatentClick(e) {
    const layer = parseInt(e.target.dataset.layer);
    const pos = parseInt(e.target.dataset.pos);
    const latentIdx = parseInt(e.target.dataset.latent);
    const value = parseFloat(e.target.dataset.value);

    // Show activation panel with wild type sequence and clicked position
    showActivationPanel(layer, latentIdx, pos, value);
}

// Get activations for a specific latent across all positions in the wild type sequence
function getWildTypeActivations(layer, latentIdx) {
    const activations = new Array(sequence.length).fill(0);
    const layerData = activationData[layer];
    if (!layerData) return activations;

    for (const pos in layerData) {
        const items = layerData[pos];
        for (const item of items) {
            if (item.latentIdx === latentIdx) {
                activations[parseInt(pos)] = item.value;
            }
        }
    }
    return activations;
}

// Render wild type sequence with activations
function renderWildTypeCard(layer, latentIdx, clickedPos, clickedValue) {
    const activations = getWildTypeActivations(layer, latentIdx);
    const maxActivation = Math.max(...activations.filter(a => a > 0));

    // Build amino acid visualization
    let aaHtml = '';
    for (let i = 0; i < sequence.length; i++) {
        const aa = sequence[i];
        const activation = activations[i] || 0;
        const isClicked = i === clickedPos;

        if (activation === 0) {
            aaHtml += `<span class="aa-char zero${isClicked ? ' clicked' : ''}" data-pos="${i}" data-aa="${aa}" data-activation="0.00">${aa}</span>`;
        } else {
            const color = getActivationColorForPanel(activation, 0, maxActivation);
            const textColor = activation > maxActivation * 0.5 ? '#000' : '#fff';
            aaHtml += `<span class="aa-char${isClicked ? ' clicked' : ''}" data-pos="${i}" data-aa="${aa}" data-activation="${activation.toFixed(2)}" style="background: ${color}; color: ${textColor}">${aa}</span>`;
        }
    }

    return `
        <div class="seq-card wild-type-card">
            <div class="seq-card-header">
                <div class="seq-card-title">
                    <h3><span class="wild-type-badge">Wild Type</span>Sequence</h3>
                </div>
            </div>
            <div class="clicked-position-info">
                <div class="clicked-label">Current Position</div>
                <div class="clicked-details">
                    <span class="clicked-pos">Position ${clickedPos + 1}</span>
                    <span class="clicked-aa">${sequence[clickedPos]}</span>
                    <span class="clicked-activation">Activation: ${clickedValue.toFixed(3)}</span>
                </div>
            </div>
            <div class="seq-visualization">
                <div class="seq-amino-acids">${aaHtml}</div>
            </div>
        </div>
    `;
}

// Current panel state for tab switching
let currentPanelState = null;
let currentInfluenceSubtab = 'incoming'; // 'incoming' or 'outgoing'

// Show the activation panel with wild type and top sequences for a latent
function showActivationPanel(layer, latentIdx, clickedPos, clickedValue) {
    // Store state for tab switching (include aa for add to canvas)
    const aa = clickedPos !== null ? sequence[clickedPos] : null;
    currentPanelState = { layer, latentIdx, clickedPos, clickedValue, aa };

    // Update panel title
    panelTitle.textContent = `Layer ${layer + 1} - Latent ${latentIdx + 1}`;

    // Add "Add to Canvas" button to header if not already present
    const panelHeader = document.getElementById('activation-panel-header');
    let addBtn = document.getElementById('panel-add-to-canvas');
    if (!addBtn) {
        addBtn = document.createElement('button');
        addBtn.id = 'panel-add-to-canvas';
        addBtn.className = 'btn-add-to-canvas';
        addBtn.textContent = 'Add to Canvas';
        addBtn.addEventListener('click', () => {
            if (currentPanelState) {
                const { layer, latentIdx, clickedPos, clickedValue, aa } = currentPanelState;
                addNodeToCanvas(latentIdx, layer, clickedPos, aa, clickedValue);
            }
        });
        panelHeader.insertBefore(addBtn, panelClose);
    }

    // Render tabs and sequences view by default
    renderSequencesTab();

    // Show panel
    activationPanel.classList.remove('hidden');
}

// Render the Sequences tab content
function renderSequencesTab() {
    const { layer, latentIdx, clickedPos, clickedValue } = currentPanelState;

    // Add tabs
    let html = renderTabs('sequences');

    // Start with wild type card
    html += renderWildTypeCard(layer, latentIdx, clickedPos, clickedValue);

    // Add separator
    html += '<div class="panel-section-title">Top Activating Sequences</div>';

    // Add top sequences if available
    if (topActivationsData && topActivationsData.layers) {
        const layerData = topActivationsData.layers[layer.toString()];
        if (layerData) {
            const latentData = layerData[latentIdx.toString()];
            if (latentData && latentData.length > 0) {
                latentData.forEach((item, idx) => {
                    html += renderSequenceCard(item, idx + 1);
                });
            } else {
                html += '<div class="no-data-message">No top sequences available for this latent.</div>';
            }
        } else {
            html += '<div class="no-data-message">No data available for this layer.</div>';
        }
    } else {
        html += '<div class="no-data-message">Top activations data not loaded.</div>';
    }

    panelContent.innerHTML = html;
    attachTabListeners();
}

// Render tab controls
function renderTabs(activeTab) {
    return `
        <div class="panel-tabs">
            <button class="panel-tab ${activeTab === 'sequences' ? 'active' : ''}" data-tab="sequences">Sequences</button>
            <button class="panel-tab ${activeTab === 'alignment' ? 'active' : ''}" data-tab="alignment">Alignment</button>
            <button class="panel-tab ${activeTab === 'influences' ? 'active' : ''}" data-tab="influences">Influences</button>
        </div>
    `;
}

// Attach tab click listeners
function attachTabListeners() {
    panelContent.querySelectorAll('.panel-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            if (tabName === 'sequences') {
                renderSequencesTab();
            } else if (tabName === 'alignment') {
                renderAlignmentTab();
            } else if (tabName === 'influences') {
                renderInfluencesTab();
            }
        });
    });
}

// Get incoming edges (influences) for a specific latent
// Returns array of { srcLayer, srcLatent, avgWeight, count } sorted by absolute weight
function getIncomingEdges(tgtLayer, tgtLatent) {
    const incoming = [];

    if (!virtualWeightsData || aggregatedVirtualWeights.size === 0) {
        return incoming;
    }

    // Iterate through aggregated weights to find edges targeting this latent
    for (const [key, data] of aggregatedVirtualWeights.entries()) {
        // Key format: "layer1-latent1:layer2-latent2" (canonical: smaller first)
        const [part1, part2] = key.split(':');
        const [layer1, latent1] = part1.split('-').map(Number);
        const [layer2, latent2] = part2.split('-').map(Number);

        // Check if this edge points TO our target latent from a lower layer
        // Case 1: part2 is the target (layer2-latent2 matches)
        if (layer2 === tgtLayer && latent2 === tgtLatent && layer1 < tgtLayer) {
            incoming.push({
                srcLayer: layer1,
                srcLatent: latent1,
                avgWeight: data.avgWeight,
                count: data.count
            });
        }
        // Case 2: part1 is the target (layer1-latent1 matches)
        else if (layer1 === tgtLayer && latent1 === tgtLatent && layer2 < tgtLayer) {
            incoming.push({
                srcLayer: layer2,
                srcLatent: latent2,
                avgWeight: data.avgWeight,
                count: data.count
            });
        }
    }

    // Sort by absolute weight strength (strongest first)
    incoming.sort((a, b) => Math.abs(b.avgWeight) - Math.abs(a.avgWeight));

    return incoming;
}

// Get outgoing edges (influences) from a specific latent to higher layers
// Returns array of { tgtLayer, tgtLatent, avgWeight, count } sorted by absolute weight
function getOutgoingEdges(srcLayer, srcLatent) {
    const outgoing = [];

    if (!virtualWeightsData || aggregatedVirtualWeights.size === 0) {
        return outgoing;
    }

    // Iterate through aggregated weights to find edges from this latent
    for (const [key, data] of aggregatedVirtualWeights.entries()) {
        // Key format: "layer1-latent1:layer2-latent2" (canonical: smaller first)
        const [part1, part2] = key.split(':');
        const [layer1, latent1] = part1.split('-').map(Number);
        const [layer2, latent2] = part2.split('-').map(Number);

        // Check if this edge goes FROM our source latent to a higher layer
        // Case 1: part1 is the source (layer1-latent1 matches)
        if (layer1 === srcLayer && latent1 === srcLatent && layer2 > srcLayer) {
            outgoing.push({
                tgtLayer: layer2,
                tgtLatent: latent2,
                avgWeight: data.avgWeight,
                count: data.count
            });
        }
        // Case 2: part2 is the source (layer2-latent2 matches)
        else if (layer2 === srcLayer && latent2 === srcLatent && layer1 > srcLayer) {
            outgoing.push({
                tgtLayer: layer1,
                tgtLatent: latent1,
                avgWeight: data.avgWeight,
                count: data.count
            });
        }
    }

    // Sort by absolute weight strength (strongest first)
    outgoing.sort((a, b) => Math.abs(b.avgWeight) - Math.abs(a.avgWeight));

    return outgoing;
}

// Render the Alignment tab content
function renderAlignmentTab() {
    const { layer, latentIdx, clickedPos, clickedValue } = currentPanelState;

    // Add tabs
    let html = renderTabs('alignment');

    // Get all sequences to align
    const sequencesToAlign = [];

    // Add wild type sequence
    const wildTypeActivations = getWildTypeActivations(layer, latentIdx);
    const wildTypeMaxIdx = findMaxActivationIndex(wildTypeActivations);
    sequencesToAlign.push({
        name: 'Wild Type',
        entry: '',
        proteinName: 'Current Sequence',
        sequence: sequence,
        activations: wildTypeActivations,
        maxIdx: wildTypeMaxIdx,
        isWildType: true
    });

    // Add top activating sequences
    if (topActivationsData && topActivationsData.layers) {
        const layerData = topActivationsData.layers[layer.toString()];
        if (layerData) {
            const latentData = layerData[latentIdx.toString()];
            if (latentData && latentData.length > 0) {
                latentData.forEach((item, idx) => {
                    const maxIdx = findMaxActivationIndex(item.Activations);
                    sequencesToAlign.push({
                        name: item['Entry Name'] || 'Unknown',
                        entry: item.Entry || 'N/A',
                        proteinName: item['Protein names'] || 'Unknown protein',
                        sequence: item.Sequence,
                        activations: item.Activations,
                        maxIdx: maxIdx,
                        isWildType: false,
                        rank: idx + 1
                    });
                });
            }
        }
    }

    // Compute alignment
    const aligned = computeMaxAlignment(sequencesToAlign);

    // Add toolbar with Go to Center button
    html += '<div class="alignment-toolbar">';
    html += `<button class="btn-go-to-center" data-center="${aligned.alignmentPosition}">Go to Center</button>`;
    html += `<span class="alignment-info">Aligned at position ${aligned.alignmentPosition + 1}</span>`;
    html += '</div>';

    // Render alignment view
    html += '<div class="alignment-container">';
    html += `<div class="alignment-scroll" id="alignment-scroll">`;

    // Render position ruler with center marker
    html += renderPositionRuler(aligned.totalLength, aligned.alignmentPosition);

    // Render each aligned sequence with center line
    aligned.sequences.forEach(seq => {
        html += renderAlignedSequence(seq, aligned.alignmentPosition);
    });

    html += '</div></div>';

    panelContent.innerHTML = html;
    attachTabListeners();
    attachAlignmentListeners();
}

// Attach alignment-specific listeners
function attachAlignmentListeners() {
    const goToCenterBtn = panelContent.querySelector('.btn-go-to-center');
    if (goToCenterBtn) {
        goToCenterBtn.addEventListener('click', () => {
            scrollToAlignmentCenter();
        });
    }
}

// Scroll to the alignment center
function scrollToAlignmentCenter() {
    const scrollContainer = document.getElementById('alignment-scroll');
    const centerMarker = scrollContainer?.querySelector('.center-line');
    if (scrollContainer && centerMarker) {
        const containerWidth = scrollContainer.clientWidth;
        const markerOffset = centerMarker.offsetLeft;
        // Scroll so the center line is in the middle of the view
        scrollContainer.scrollLeft = markerOffset - (containerWidth / 2) + 10;
    }
}

// Render the Influences tab content
function renderInfluencesTab() {
    const { layer, latentIdx } = currentPanelState;

    // Add tabs
    let html = renderTabs('influences');

    // Add subtabs for incoming/outgoing
    html += `
        <div class="influence-subtabs">
            <button class="influence-subtab ${currentInfluenceSubtab === 'incoming' ? 'active' : ''}" data-subtab="incoming">Incoming</button>
            <button class="influence-subtab ${currentInfluenceSubtab === 'outgoing' ? 'active' : ''}" data-subtab="outgoing">Outgoing</button>
        </div>
    `;

    if (currentInfluenceSubtab === 'incoming') {
        html += renderIncomingInfluences(layer, latentIdx);
    } else {
        html += renderOutgoingInfluences(layer, latentIdx);
    }

    panelContent.innerHTML = html;
    attachTabListeners();
    attachInfluenceSubtabListeners();
    attachInfluenceListeners();
}

// Render incoming influences content
function renderIncomingInfluences(layer, latentIdx) {
    let html = '';
    const incomingEdges = getIncomingEdges(layer, latentIdx);

    // Header info
    html += `
        <div class="influences-header">
            <div class="influences-summary">
                <span class="influences-count">${incomingEdges.length} incoming connection${incomingEdges.length !== 1 ? 's' : ''}</span>
                <span class="influences-target">to Layer ${layer + 1}, Latent ${latentIdx + 1}</span>
            </div>
        </div>
    `;

    if (incomingEdges.length === 0) {
        if (layer === 0) {
            html += '<div class="no-data-message">Layer 1 latents have no incoming influences (they are the input layer).</div>';
        } else if (!virtualWeightsData) {
            html += '<div class="no-data-message">Virtual weights data not loaded. Upload virtual_weights.json to see influences.</div>';
        } else {
            html += '<div class="no-data-message">No incoming influences found for this latent.</div>';
        }
    } else {
        // Calculate min/max for color scaling
        const weights = incomingEdges.map(e => e.avgWeight);
        const minWeight = Math.min(...weights);
        const maxWeight = Math.max(...weights);

        html += '<div class="influences-list">';

        incomingEdges.forEach((edge, index) => {
            const weightSign = edge.avgWeight >= 0 ? 'positive' : 'negative';
            const weightColor = getEdgeColor(edge.avgWeight, minWeight, maxWeight);

            html += `
                <div class="influence-card"
                     data-src-layer="${edge.srcLayer}"
                     data-src-latent="${edge.srcLatent}"
                     data-direction="incoming">
                    <div class="influence-rank">#${index + 1}</div>
                    <div class="influence-source">
                        <span class="influence-layer">Layer ${edge.srcLayer + 1}</span>
                        <span class="influence-latent">Latent ${edge.srcLatent + 1}</span>
                    </div>
                    <div class="influence-weight ${weightSign}" style="background: ${weightColor}">
                        ${edge.avgWeight >= 0 ? '+' : ''}${edge.avgWeight.toFixed(4)}
                    </div>
                    <div class="influence-meta">
                        <span class="influence-edge-count">${edge.count} edge${edge.count !== 1 ? 's' : ''}</span>
                    </div>
                    <button class="btn-view-source" title="View source latent">View</button>
                </div>
            `;
        });

        html += '</div>';
    }

    return html;
}

// Render outgoing influences content
function renderOutgoingInfluences(layer, latentIdx) {
    let html = '';
    const outgoingEdges = getOutgoingEdges(layer, latentIdx);

    // Determine if this is the last layer
    const numLayers = Object.keys(activationData).length;
    const isLastLayer = layer === numLayers - 1;

    // Header info
    html += `
        <div class="influences-header">
            <div class="influences-summary">
                <span class="influences-count">${outgoingEdges.length} outgoing connection${outgoingEdges.length !== 1 ? 's' : ''}</span>
                <span class="influences-target">from Layer ${layer + 1}, Latent ${latentIdx + 1}</span>
            </div>
        </div>
    `;

    if (outgoingEdges.length === 0) {
        if (isLastLayer) {
            html += '<div class="no-data-message">This is the final layer - no outgoing influences.</div>';
        } else if (!virtualWeightsData) {
            html += '<div class="no-data-message">Virtual weights data not loaded. Upload virtual_weights.json to see influences.</div>';
        } else {
            html += '<div class="no-data-message">No outgoing influences found for this latent.</div>';
        }
    } else {
        // Calculate min/max for color scaling
        const weights = outgoingEdges.map(e => e.avgWeight);
        const minWeight = Math.min(...weights);
        const maxWeight = Math.max(...weights);

        html += '<div class="influences-list">';

        outgoingEdges.forEach((edge, index) => {
            const weightSign = edge.avgWeight >= 0 ? 'positive' : 'negative';
            const weightColor = getEdgeColor(edge.avgWeight, minWeight, maxWeight);

            html += `
                <div class="influence-card"
                     data-tgt-layer="${edge.tgtLayer}"
                     data-tgt-latent="${edge.tgtLatent}"
                     data-direction="outgoing">
                    <div class="influence-rank">#${index + 1}</div>
                    <div class="influence-source">
                        <span class="influence-layer">Layer ${edge.tgtLayer + 1}</span>
                        <span class="influence-latent">Latent ${edge.tgtLatent + 1}</span>
                    </div>
                    <div class="influence-weight ${weightSign}" style="background: ${weightColor}">
                        ${edge.avgWeight >= 0 ? '+' : ''}${edge.avgWeight.toFixed(4)}
                    </div>
                    <div class="influence-meta">
                        <span class="influence-edge-count">${edge.count} edge${edge.count !== 1 ? 's' : ''}</span>
                    </div>
                    <button class="btn-view-source" title="View target latent">View</button>
                </div>
            `;
        });

        html += '</div>';
    }

    return html;
}

// Attach click listeners for influence subtabs
function attachInfluenceSubtabListeners() {
    panelContent.querySelectorAll('.influence-subtab').forEach(tab => {
        tab.addEventListener('click', () => {
            currentInfluenceSubtab = tab.dataset.subtab;
            renderInfluencesTab();
        });
    });
}

// Attach click listeners for influence cards
function attachInfluenceListeners() {
    panelContent.querySelectorAll('.influence-card').forEach(card => {
        const viewBtn = card.querySelector('.btn-view-source');
        if (viewBtn) {
            viewBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const direction = card.dataset.direction;

                let targetLayer, targetLatent;
                if (direction === 'outgoing') {
                    // For outgoing, navigate to target latent
                    targetLayer = parseInt(card.dataset.tgtLayer);
                    targetLatent = parseInt(card.dataset.tgtLatent);
                } else {
                    // For incoming, navigate to source latent
                    targetLayer = parseInt(card.dataset.srcLayer);
                    targetLatent = parseInt(card.dataset.srcLatent);
                }

                // Get activations for the target latent
                const activations = getWildTypeActivations(targetLayer, targetLatent);
                const maxIdx = findMaxActivationIndex(activations);
                const maxValue = activations[maxIdx] || 0;

                // Navigate to that latent's panel
                showActivationPanel(targetLayer, targetLatent, maxIdx, maxValue);
            });
        }
    });
}

// Find the index of max activation in an array
function findMaxActivationIndex(activations) {
    let maxVal = -Infinity;
    let maxIdx = 0;
    for (let i = 0; i < activations.length; i++) {
        if (activations[i] > maxVal) {
            maxVal = activations[i];
            maxIdx = i;
        }
    }
    return maxIdx;
}

// Compute max activation alignment
function computeMaxAlignment(sequences) {
    // Find the maximum offset needed (the largest maxIdx)
    const maxOffset = Math.max(...sequences.map(s => s.maxIdx));

    // Calculate aligned sequences
    const alignedSequences = sequences.map(seq => {
        const leftPadding = maxOffset - seq.maxIdx;
        const alignedLength = leftPadding + seq.sequence.length;

        return {
            ...seq,
            leftPadding,
            alignedLength
        };
    });

    // Find total length (max of all aligned lengths)
    const totalLength = Math.max(...alignedSequences.map(s => s.alignedLength));

    // Add right padding info
    alignedSequences.forEach(seq => {
        seq.rightPadding = totalLength - seq.alignedLength;
    });

    return {
        sequences: alignedSequences,
        totalLength,
        alignmentPosition: maxOffset
    };
}

// Render position ruler for alignment
function renderPositionRuler(totalLength, centerPosition) {
    let html = '<div class="alignment-row ruler-row"><div class="alignment-label"></div><div class="alignment-sequence">';

    for (let i = 0; i < totalLength; i++) {
        const isCenter = i === centerPosition;
        const centerClass = isCenter ? ' center-line' : '';

        if (i % 10 === 0) {
            html += `<span class="ruler-mark${centerClass}">${i + 1}</span>`;
        } else if (i % 5 === 0) {
            html += `<span class="ruler-tick${centerClass}">|</span>`;
        } else {
            html += `<span class="ruler-dot${centerClass}">·</span>`;
        }
    }

    html += '</div></div>';
    return html;
}

// Render a single aligned sequence
function renderAlignedSequence(seq, centerPosition) {
    const maxActivation = Math.max(...seq.activations.filter(a => a > 0));

    let html = `<div class="alignment-row ${seq.isWildType ? 'wild-type-row' : ''}">`;

    // Label
    html += '<div class="alignment-label">';
    if (seq.isWildType) {
        html += '<span class="wild-type-badge">WT</span>';
    } else {
        html += `<span class="rank-badge">#${seq.rank}</span>`;
    }
    html += `<span class="alignment-entry">${seq.entry}${seq.entry ? ' ' : ''}(${seq.name})</span>`;
    html += '</div>';

    // Sequence with padding
    html += '<div class="alignment-sequence">';

    // Track aligned position (for center line)
    let alignedPos = 0;

    // Left padding
    for (let i = 0; i < seq.leftPadding; i++) {
        const isCenter = alignedPos === centerPosition;
        html += `<span class="aa-char gap${isCenter ? ' center-line' : ''}">-</span>`;
        alignedPos++;
    }

    // Actual sequence
    for (let i = 0; i < seq.sequence.length; i++) {
        const aa = seq.sequence[i];
        const activation = seq.activations[i] || 0;
        const isMax = i === seq.maxIdx;
        const isCenter = alignedPos === centerPosition;
        const centerClass = isCenter ? ' center-line' : '';

        if (activation === 0) {
            html += `<span class="aa-char zero ${isMax ? 'max-pos' : ''}${centerClass}" data-pos="${i}" data-aa="${aa}" data-activation="0.00">${aa}</span>`;
        } else {
            const color = getActivationColorForPanel(activation, 0, maxActivation);
            const textColor = activation > maxActivation * 0.5 ? '#000' : '#fff';
            html += `<span class="aa-char ${isMax ? 'max-pos' : ''}${centerClass}" data-pos="${i}" data-aa="${aa}" data-activation="${activation.toFixed(2)}" style="background: ${color}; color: ${textColor}">${aa}</span>`;
        }
        alignedPos++;
    }

    // Right padding
    for (let i = 0; i < seq.rightPadding; i++) {
        const isCenter = alignedPos === centerPosition;
        html += `<span class="aa-char gap${isCenter ? ' center-line' : ''}">-</span>`;
        alignedPos++;
    }

    html += '</div></div>';

    return html;
}

// Render a single sequence card
function renderSequenceCard(item, rank) {
    const { Score, Activations, Sequence, 'Entry Name': entryName, 'Protein names': proteinNames, Entry, seq_len } = item;

    // Find max activation for color scaling
    const maxActivation = Math.max(...Activations);

    // Build amino acid visualization
    let aaHtml = '';
    for (let i = 0; i < Sequence.length; i++) {
        const aa = Sequence[i];
        const activation = Activations[i] || 0;

        if (activation === 0) {
            aaHtml += `<span class="aa-char zero" data-pos="${i}" data-aa="${aa}" data-activation="0.00">${aa}</span>`;
        } else {
            const color = getActivationColorForPanel(activation, 0, maxActivation);
            const textColor = activation > maxActivation * 0.5 ? '#000' : '#fff';
            aaHtml += `<span class="aa-char" data-pos="${i}" data-aa="${aa}" data-activation="${activation.toFixed(2)}" style="background: ${color}; color: ${textColor}">${aa}</span>`;
        }
    }

    return `
        <div class="seq-card">
            <div class="seq-card-header">
                <div class="seq-card-title">
                    <h3><span class="rank-badge">#${rank}</span>${Entry || 'N/A'} (${entryName || 'Unknown'})</h3>
                    <p class="protein-name">${proteinNames || 'Unknown protein'}</p>
                </div>
                <div class="seq-card-score">Score: ${Score.toFixed(2)}</div>
            </div>
            <div class="seq-card-meta">
                <span>Length: ${seq_len || Sequence.length} aa</span>
            </div>
            <div class="seq-visualization">
                <div class="seq-amino-acids">${aaHtml}</div>
            </div>
        </div>
    `;
}

// Color scale for panel activation values (light red to dark red gradient)
function getActivationColorForPanel(value, minVal, maxVal) {
    if (maxVal === minVal) return 'rgb(255, 211, 211)';
    const t = (value - minVal) / (maxVal - minVal);
    const r = 255;
    const g = Math.round(211 - t * 178);  // 211 to 33
    const b = Math.round(211 - t * 178);  // 211 to 33
    return `rgb(${r}, ${g}, ${b})`;
}

// Color scale for edge weights (blue for negative, red for positive)
function getEdgeColor(weight, minWeight, maxWeight) {
    // Color definitions
    // Negative: #82ccdd (light blue) -> #eb2f06 (red)
    const negLow = { r: 248, g: 194, b: 145 };  // #f8c291
    const negHigh = { r: 235, g: 47, b: 6 };   // #eb2f06
    // Positive: #f8c291 (light orange) -> #3c6382 (dark blue)
    const posLow = { r: 130, g: 204, b: 221 };  //  #82ccdd
    const posHigh = { r: 60, g: 99, b: 130 };    //  #3c6382

    // Handle edge case where all weights are the same
    if (maxWeight === minWeight) {
        if (weight >= 0) {
            // Midpoint of positive range
            return `rgb(${Math.round((posLow.r + posHigh.r) / 2)}, ${Math.round((posLow.g + posHigh.g) / 2)}, ${Math.round((posLow.b + posHigh.b) / 2)})`;
        } else {
            // Midpoint of negative range
            return `rgb(${Math.round((negLow.r + negHigh.r) / 2)}, ${Math.round((negLow.g + negHigh.g) / 2)}, ${Math.round((negLow.b + negHigh.b) / 2)})`;
        }
    }

    // Normalize weight to [-1, 1] range based on the maximum absolute value
    const maxAbs = Math.max(Math.abs(minWeight), Math.abs(maxWeight));
    const normalized = maxAbs === 0 ? 0 : weight / maxAbs;

    // Interpolate between colors based on magnitude
    let r, g, b;
    const t = Math.abs(normalized); // magnitude from 0 to 1

    if (normalized < 0) {
        // Negative: light blue (#82ccdd) -> dark blue (#3c6382)
        r = Math.round(negLow.r + t * (negHigh.r - negLow.r));
        g = Math.round(negLow.g + t * (negHigh.g - negLow.g));
        b = Math.round(negLow.b + t * (negHigh.b - negLow.b));
    } else {
        // Positive: light orange (#f8c291) -> red (#eb2f06)
        r = Math.round(posLow.r + t * (posHigh.r - posLow.r));
        g = Math.round(posLow.g + t * (posHigh.g - posLow.g));
        b = Math.round(posLow.b + t * (posHigh.b - posLow.b));
    }

    return `rgb(${r}, ${g}, ${b})`;
}

// Close panel handler
panelClose.addEventListener('click', () => {
    activationPanel.classList.add('hidden');
});

// Close layer panel handler
layerPanelClose.addEventListener('click', () => {
    layerPanel.classList.add('hidden');
});

// Tooltip for amino acid hover
let aaTooltip = null;

function createTooltip() {
    if (!aaTooltip) {
        aaTooltip = document.createElement('div');
        aaTooltip.className = 'aa-tooltip';
        aaTooltip.style.display = 'none';
        document.body.appendChild(aaTooltip);
    }
    return aaTooltip;
}

function showAATooltip(e) {
    const target = e.target;
    if (!target.classList.contains('aa-char')) return;

    const pos = target.dataset.pos;
    const aa = target.dataset.aa;
    const activation = target.dataset.activation;

    const tooltip = createTooltip();
    tooltip.innerHTML = `<span class="tooltip-pos">Pos ${parseInt(pos) + 1}</span><span class="tooltip-aa">${aa}</span><span class="tooltip-val">${activation}</span>`;
    tooltip.style.display = 'block';

    // Position tooltip near cursor
    const x = e.clientX + 10;
    const y = e.clientY - 30;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';
}

function hideAATooltip(e) {
    if (aaTooltip) {
        aaTooltip.style.display = 'none';
    }
}

function moveAATooltip(e) {
    if (aaTooltip && aaTooltip.style.display !== 'none') {
        const x = e.clientX + 10;
        const y = e.clientY - 30;
        aaTooltip.style.left = x + 'px';
        aaTooltip.style.top = y + 'px';
    }
}

// Add tooltip listeners to panel content
panelContent.addEventListener('mouseover', showAATooltip);
panelContent.addEventListener('mouseout', hideAATooltip);
panelContent.addEventListener('mousemove', moveAATooltip);

// Add tooltip listeners to layer panel content
layerPanelContent.addEventListener('mouseover', showAATooltip);
layerPanelContent.addEventListener('mouseout', hideAATooltip);
layerPanelContent.addEventListener('mousemove', moveAATooltip);

// ============================================
// Layer Panel - Latent Rankings by Max Activation
// ============================================

// Setup layer label click handlers
document.querySelectorAll('.layer-label').forEach((label, index) => {
    label.addEventListener('click', () => {
        // Labels are ordered 5 to 0 in the DOM
        const layer = 5 - index;
        showLayerPanel(layer);
    });
});

// Show layer panel with latent rankings for a specific layer
function showLayerPanel(layer) {
    layerPanelTitle.textContent = `Layer ${layer + 1} - Latent Rankings`;

    // Collect all latents for this layer with their max activations
    const latentMaxActivations = [];
    const layerData = activationData[layer];

    if (layerData) {
        // Collect all unique latent indices
        const latentSet = new Set();
        for (const pos in layerData) {
            for (const item of layerData[pos]) {
                latentSet.add(item.latentIdx);
            }
        }

        // For each latent, find max activation and position
        for (const latentIdx of latentSet) {
            const activations = getWildTypeActivations(layer, latentIdx);
            let maxVal = 0;
            let maxPos = 0;
            activations.forEach((val, pos) => {
                if (val > maxVal) {
                    maxVal = val;
                    maxPos = pos;
                }
            });
            latentMaxActivations.push({ latentIdx, maxVal, maxPos, activations });
        }
    }

    // Sort by max activation descending
    latentMaxActivations.sort((a, b) => b.maxVal - a.maxVal);

    // Render panel content
    renderLayerPanelContent(layer, latentMaxActivations);

    // Show panel
    layerPanel.classList.remove('hidden');
}

// Render the layer panel content with ranked latents
function renderLayerPanelContent(layer, latentMaxActivations) {
    if (latentMaxActivations.length === 0) {
        layerPanelContent.innerHTML = '<div class="no-data-message">No latents found for this layer.</div>';
        return;
    }

    let html = '';

    latentMaxActivations.forEach((item, index) => {
        const { latentIdx, maxVal, maxPos, activations } = item;
        const aa = sequence[maxPos];
        const maxActivation = maxVal;

        // Build heatmap of activations
        let heatmapHtml = '';
        for (let i = 0; i < sequence.length; i++) {
            const seqAa = sequence[i];
            const activation = activations[i] || 0;
            const isMax = i === maxPos;

            if (activation === 0) {
                heatmapHtml += `<span class="aa-char zero${isMax ? ' max-highlight' : ''}" data-pos="${i}" data-aa="${seqAa}" data-activation="0.00">${seqAa}</span>`;
            } else {
                const color = getActivationColorForPanel(activation, 0, maxActivation);
                const textColor = activation > maxActivation * 0.5 ? '#000' : '#fff';
                heatmapHtml += `<span class="aa-char${isMax ? ' max-highlight' : ''}" data-pos="${i}" data-aa="${seqAa}" data-activation="${activation.toFixed(2)}" style="background: ${color}; color: ${textColor}">${seqAa}</span>`;
            }
        }

        html += `
            <div class="latent-rank-card" data-layer="${layer}" data-latent="${latentIdx}" data-pos="${maxPos}">
                <div class="latent-rank-header">
                    <span class="latent-rank-number">#${index + 1}</span>
                    <div class="latent-rank-info">
                        <span class="latent-rank-idx">Latent ${latentIdx + 1}</span>
                        <span class="latent-rank-max">Max: ${maxVal.toFixed(3)}</span>
                        <span class="latent-rank-pos">@ Pos ${maxPos + 1} (${aa})</span>
                    </div>
                    <div class="latent-rank-actions">
                        <button class="btn-add-to-canvas" title="Add node to canvas">Add to Canvas</button>
                        <button class="btn-feature-info" title="View feature information">Feature Info</button>
                    </div>
                </div>
                <div class="latent-heatmap">
                    <div class="seq-amino-acids">${heatmapHtml}</div>
                </div>
            </div>
        `;
    });

    layerPanelContent.innerHTML = html;

    // Add click handlers for Feature Info buttons
    layerPanelContent.querySelectorAll('.btn-feature-info').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = btn.closest('.latent-rank-card');
            const cardLayer = parseInt(card.dataset.layer);
            const latentIdx = parseInt(card.dataset.latent);
            const pos = parseInt(card.dataset.pos);
            const activations = getWildTypeActivations(cardLayer, latentIdx);
            const value = activations[pos] || 0;

            // Open the activation panel for this latent
            showActivationPanel(cardLayer, latentIdx, pos, value);
        });
    });

    // Add click handlers for Add to Canvas buttons
    layerPanelContent.querySelectorAll('.btn-add-to-canvas').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const card = btn.closest('.latent-rank-card');
            const cardLayer = parseInt(card.dataset.layer);
            const latentIdx = parseInt(card.dataset.latent);
            const pos = parseInt(card.dataset.pos);
            const aa = sequence[pos];
            const activations = getWildTypeActivations(cardLayer, latentIdx);
            const value = activations[pos] || 0;

            // Add node to canvas
            addNodeToCanvas(latentIdx, cardLayer, pos, aa, value);

            // Close the layer panel
            layerPanel.classList.add('hidden');
        });
    });
}

// Add node to canvas
function addNodeToCanvas(latentIdx, layer, pos, aa, value, isSuper = false, children = []) {
    // Prevent duplicate nodes (same layer/latentIdx)
    if (!isSuper) {
        const existingNode = canvasNodes.find(n =>
            !n.isSuper &&
            n.layer === layer &&
            n.latentIdx === latentIdx
        );
        if (existingNode) {
            // Highlight existing node briefly
            const existingEl = nodesContainer.querySelector(`[data-id="${existingNode.id}"]`);
            if (existingEl) {
                existingEl.classList.add('highlight-pulse');
                setTimeout(() => existingEl.classList.remove('highlight-pulse'), 500);
            }
            return existingNode;
        }
    }

    const id = nodeIdCounter++;
    const containerRect = nodesContainer.getBoundingClientRect();

    // Position new nodes in a grid pattern
    const nodesPerRow = 5;
    const nodeCount = canvasNodes.length;
    const x = 20 + (nodeCount % nodesPerRow) * 120;
    const y = 20 + Math.floor(nodeCount / nodesPerRow) * 80;

    const node = {
        id,
        x,
        y,
        latentIdx,
        layer,
        pos,
        aa,
        value,
        isSuper,
        children,
        name: ''
    };

    canvasNodes.push(node);
    renderNode(node);

    // Auto-connect based on virtual weights
    if (!isSuper) {
        checkAndCreateVirtualEdges(node);
    }

    return node;
}

// Find a canvas node by layer and latentIdx (feature)
function findCanvasNode(layer, latentIdx) {
    return canvasNodes.find(n =>
        !n.isSuper &&
        n.layer === layer &&
        n.latentIdx === latentIdx
    );
}

// Precompute averaged weights by (layer, latent) pairs across all positions
function preprocessVirtualWeights() {
    aggregatedVirtualWeights.clear();
    if (!virtualWeightsData) return;

    for (const [srcPos, srcLayer, srcFeature, tgtPos, tgtLayer, tgtFeature, weight] of virtualWeightsData) {
        // Create canonical key (smaller layer-latent first for consistency)
        const key1 = `${srcLayer}-${srcFeature}`;
        const key2 = `${tgtLayer}-${tgtFeature}`;
        const key = key1 < key2 ? `${key1}:${key2}` : `${key2}:${key1}`;

        if (!aggregatedVirtualWeights.has(key)) {
            aggregatedVirtualWeights.set(key, { totalWeight: 0, count: 0 });
        }
        const entry = aggregatedVirtualWeights.get(key);
        entry.totalWeight += weight;
        entry.count += 1;
    }

    // Calculate averages
    for (const entry of aggregatedVirtualWeights.values()) {
        entry.avgWeight = entry.totalWeight / entry.count;
    }
}

// Check aggregated virtual weights and create edges for connected nodes
function checkAndCreateVirtualEdges(newNode) {
    if (!virtualWeightsData || aggregatedVirtualWeights.size === 0) return;

    for (const existingNode of canvasNodes) {
        if (existingNode.isSuper || existingNode.id === newNode.id) continue;

        // Create canonical key
        const key1 = `${newNode.layer}-${newNode.latentIdx}`;
        const key2 = `${existingNode.layer}-${existingNode.latentIdx}`;
        const key = key1 < key2 ? `${key1}:${key2}` : `${key2}:${key1}`;

        const weightData = aggregatedVirtualWeights.get(key);
        if (weightData) {
            createVirtualEdge(newNode, existingNode, weightData.avgWeight);
        }
    }
}

// Create a virtual edge between two nodes with weight
function createVirtualEdge(fromNode, toNode, weight) {
    // Check if edge already exists
    const exists = edges.some(e =>
        (e.from === fromNode.id && e.to === toNode.id) ||
        (e.from === toNode.id && e.to === fromNode.id)
    );
    if (exists) return;

    const edge = {
        id: edgeIdCounter++,
        from: fromNode.id,
        to: toNode.id,
        weight: weight,
        isVirtual: true
    };
    edges.push(edge);
    updateEdges();
}

// Render a single node
function renderNode(node) {
    const div = document.createElement('div');
    div.className = 'canvas-node' + (node.isSuper ? ' super-node' : '');
    div.dataset.id = node.id;
    div.style.left = node.x + 'px';
    div.style.top = node.y + 'px';

    if (node.isSuper) {
        const latentIds = node.children.map(c => 'L' + (c.latentIdx + 1)).join(', ');
        div.innerHTML = `
            <div class="node-latent">${latentIds}</div>
            <div class="node-info">Super Node (${node.children.length} items)</div>
        `;
    } else {
        div.innerHTML = `
            <div class="node-latent">L${node.layer + 1}/${node.latentIdx + 1}</div>
            ${node.name ? `<div class="node-name">${node.name}</div>` : ''}
        `;
    }

    // Event handlers
    div.addEventListener('mousedown', startDrag);
    div.addEventListener('click', handleNodeClick);

    nodesContainer.appendChild(div);
}

// Handle node click for selection
function handleNodeClick(e) {
    e.stopPropagation();
    const id = parseInt(e.currentTarget.dataset.id);

    if (e.ctrlKey || e.metaKey) {
        // Toggle selection
        if (selectedNodes.has(id)) {
            selectedNodes.delete(id);
        } else {
            selectedNodes.add(id);
        }
    } else {
        // Single select
        selectedNodes.clear();
        selectedEdges.clear();
        selectedNodes.add(id);
    }

    updateSelectionUI();
}

// Update selection visual
function updateSelectionUI() {
    nodesContainer.querySelectorAll('.canvas-node').forEach(el => {
        const id = parseInt(el.dataset.id);
        el.classList.toggle('selected', selectedNodes.has(id));
    });

    edgesSvg.querySelectorAll('line').forEach(el => {
        const id = parseInt(el.dataset.id);
        el.classList.toggle('selected', selectedEdges.has(id));
    });
}

// Drag handling
function startDrag(e) {
    if (e.button !== 0) return;

    const nodeEl = e.currentTarget;
    const id = parseInt(nodeEl.dataset.id);
    const node = canvasNodes.find(n => n.id === id);

    dragState = {
        node,
        nodeEl,
        startX: e.clientX,
        startY: e.clientY,
        origX: node.x,
        origY: node.y
    };

    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
    e.preventDefault();
}

function onDrag(e) {
    if (!dragState) return;

    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;

    dragState.node.x = dragState.origX + dx;
    dragState.node.y = dragState.origY + dy;
    dragState.nodeEl.style.left = dragState.node.x + 'px';
    dragState.nodeEl.style.top = dragState.node.y + 'px';

    updateEdges();
}

function endDrag() {
    dragState = null;
    document.removeEventListener('mousemove', onDrag);
    document.removeEventListener('mouseup', endDrag);
}

// Delete selected nodes/edges
function deleteSelected() {
    if (selectedNodes.size === 0 && selectedEdges.size === 0) {
        alert('Nothing selected to delete');
        return;
    }

    // Delete edges first
    for (const edgeId of selectedEdges) {
        const idx = edges.findIndex(e => e.id === edgeId);
        if (idx !== -1) edges.splice(idx, 1);
    }

    deleteSelectedInternal(Array.from(selectedNodes));

    selectedNodes.clear();
    selectedEdges.clear();
    updateEdges();
    updateSelectionUI();
}

function deleteSelectedInternal(nodeIds) {
    for (const id of nodeIds) {
        // Remove edges connected to this node
        edges = edges.filter(e => e.from !== id && e.to !== id);

        // Remove node
        const idx = canvasNodes.findIndex(n => n.id === id);
        if (idx !== -1) canvasNodes.splice(idx, 1);

        // Remove DOM element
        const el = nodesContainer.querySelector(`[data-id="${id}"]`);
        if (el) el.remove();
    }
}

// Canvas edge tooltip
let canvasEdgeTooltip = null;

function showEdgeTooltip(e, weight) {
    if (!canvasEdgeTooltip) {
        canvasEdgeTooltip = document.createElement('div');
        canvasEdgeTooltip.className = 'edge-tooltip';
        document.body.appendChild(canvasEdgeTooltip);
    }
    canvasEdgeTooltip.textContent = `Weight: ${weight.toFixed(3)}`;
    canvasEdgeTooltip.style.display = 'block';
    canvasEdgeTooltip.style.left = (e.clientX + 10) + 'px';
    canvasEdgeTooltip.style.top = (e.clientY - 30) + 'px';
}

function hideEdgeTooltip() {
    if (canvasEdgeTooltip) canvasEdgeTooltip.style.display = 'none';
}

// Update edge rendering
function updateEdges() {
    edgesSvg.innerHTML = '';

    // Find min/max weights for virtual edges to normalize colors
    let minWeight = Infinity, maxWeight = -Infinity;
    for (const edge of edges) {
        if (edge.isVirtual && edge.weight !== undefined) {
            minWeight = Math.min(minWeight, edge.weight);
            maxWeight = Math.max(maxWeight, edge.weight);
        }
    }
    if (!isFinite(minWeight)) minWeight = 0;
    if (!isFinite(maxWeight)) maxWeight = 0;

    for (const edge of edges) {
        const fromNode = canvasNodes.find(n => n.id === edge.from);
        const toNode = canvasNodes.find(n => n.id === edge.to);

        if (!fromNode || !toNode) continue;

        const fromEl = nodesContainer.querySelector(`[data-id="${fromNode.id}"]`);
        const toEl = nodesContainer.querySelector(`[data-id="${toNode.id}"]`);

        if (!fromEl || !toEl) continue;

        const fromX = fromNode.x + fromEl.offsetWidth / 2;
        const fromY = fromNode.y + fromEl.offsetHeight / 2;
        const toX = toNode.x + toEl.offsetWidth / 2;
        const toY = toNode.y + toEl.offsetHeight / 2;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', fromX);
        line.setAttribute('y1', fromY);
        line.setAttribute('x2', toX);
        line.setAttribute('y2', toY);
        line.dataset.id = edge.id;
        line.style.pointerEvents = 'stroke';

        // Apply weight-based styling for virtual edges
        if (edge.isVirtual && edge.weight !== undefined) {
            // Scale stroke width based on weight magnitude (2-8px)
            const maxAbsWeight = Math.max(Math.abs(minWeight), Math.abs(maxWeight));
            const normalizedMagnitude = maxAbsWeight === 0 ? 0.5 : Math.abs(edge.weight) / maxAbsWeight;
            const strokeWidth = 2 + normalizedMagnitude * 6;
            // Get color based on weight sign and magnitude
            const edgeColor = getEdgeColor(edge.weight, minWeight, maxWeight);
            // Use inline styles to override CSS rules
            line.style.stroke = edgeColor;
            line.style.strokeWidth = strokeWidth + 'px';
            line.style.strokeOpacity = '1';
            line.classList.add('virtual-edge');
            line.dataset.weight = edge.weight.toFixed(3);
            line.dataset.color = edgeColor;
            line.style.pointerEvents = 'none'; // Let hitArea handle events
        }

        line.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.ctrlKey || e.metaKey) {
                if (selectedEdges.has(edge.id)) {
                    selectedEdges.delete(edge.id);
                } else {
                    selectedEdges.add(edge.id);
                }
            } else {
                selectedNodes.clear();
                selectedEdges.clear();
                selectedEdges.add(edge.id);
            }
            updateSelectionUI();
        });

        edgesSvg.appendChild(line);

        // Create invisible wider line for better hover detection (on top of visible line)
        if (edge.isVirtual && edge.weight !== undefined) {
            const hitArea = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            hitArea.setAttribute('x1', fromX);
            hitArea.setAttribute('y1', fromY);
            hitArea.setAttribute('x2', toX);
            hitArea.setAttribute('y2', toY);
            hitArea.style.stroke = 'transparent';
            hitArea.style.strokeWidth = '15px';
            hitArea.style.pointerEvents = 'stroke';
            hitArea.style.cursor = 'pointer';

            // Add hover tooltip handlers
            hitArea.addEventListener('mouseenter', (e) => showEdgeTooltip(e, edge.weight));
            hitArea.addEventListener('mouseleave', hideEdgeTooltip);
            hitArea.addEventListener('mousemove', (e) => {
                if (canvasEdgeTooltip) {
                    canvasEdgeTooltip.style.left = (e.clientX + 10) + 'px';
                    canvasEdgeTooltip.style.top = (e.clientY - 30) + 'px';
                }
            });

            // Also handle click on hitArea for selection
            hitArea.addEventListener('click', (e) => {
                e.stopPropagation();
                if (e.ctrlKey || e.metaKey) {
                    if (selectedEdges.has(edge.id)) {
                        selectedEdges.delete(edge.id);
                    } else {
                        selectedEdges.add(edge.id);
                    }
                } else {
                    selectedNodes.clear();
                    selectedEdges.clear();
                    selectedEdges.add(edge.id);
                }
                updateSelectionUI();
            });

            edgesSvg.appendChild(hitArea);
        }
    }
}

// Clear selection when clicking canvas background
document.getElementById('canvas-container').addEventListener('click', (e) => {
    if (e.target.id === 'canvas-container' || e.target.id === 'nodes-container') {
        selectedNodes.clear();
        selectedEdges.clear();
        updateSelectionUI();
    }
});

// Button handlers
btnDelete.addEventListener('click', deleteSelected);

// Fullscreen toggle
const btnFullscreen = document.getElementById('btn-fullscreen');
const canvasSection = document.getElementById('canvas-section');

btnFullscreen.addEventListener('click', () => {
    canvasSection.classList.toggle('fullscreen');
    btnFullscreen.textContent = canvasSection.classList.contains('fullscreen') ? 'Exit Fullscreen' : 'Fullscreen';
    // Redraw edges after resize
    setTimeout(updateEdges, 100);
});

// Save/Load Canvas State
const btnSaveCanvas = document.getElementById('btn-save-canvas');
const btnLoadCanvas = document.getElementById('btn-load-canvas');
const canvasFileInput = document.getElementById('canvas-file-input');

function saveCanvasState() {
    const state = {
        version: 1,
        timestamp: new Date().toISOString(),
        nodeIdCounter: nodeIdCounter,
        edgeIdCounter: edgeIdCounter,
        canvasNodes: canvasNodes,
        edges: edges.filter(e => !e.isVirtual) // Only save user-created edges
    };

    const json = JSON.stringify(state, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `canvas-state-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function saveCanvasAsSVG() {
    if (canvasNodes.length === 0) {
        alert('No nodes to export');
        return;
    }

    // 1. Calculate bounds from all nodes
    const padding = 40;
    const nodeWidth = 100;
    const nodeHeight = 50;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const node of canvasNodes) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + nodeWidth);
        maxY = Math.max(maxY, node.y + nodeHeight);
    }

    const width = maxX - minX + padding * 2;
    const height = maxY - minY + padding * 2;
    const offsetX = -minX + padding;
    const offsetY = -minY + padding;

    // 2. Find weight range for edge styling
    let minWeight = Infinity, maxWeight = -Infinity;
    for (const edge of edges) {
        if (edge.weight !== undefined) {
            minWeight = Math.min(minWeight, edge.weight);
            maxWeight = Math.max(maxWeight, edge.weight);
        }
    }
    if (!isFinite(minWeight)) minWeight = 0;
    if (!isFinite(maxWeight)) maxWeight = 0;
    const maxAbsWeight = Math.max(Math.abs(minWeight), Math.abs(maxWeight));

    // 3. Create SVG
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`;
    svg += `<rect width="100%" height="100%" fill="#ffffff"/>`;

    // 4. Draw edges
    svg += '<g id="edges">';
    for (const edge of edges) {
        const fromNode = canvasNodes.find(n => n.id === edge.from);
        const toNode = canvasNodes.find(n => n.id === edge.to);
        if (!fromNode || !toNode) continue;

        const x1 = fromNode.x + offsetX + nodeWidth / 2;
        const y1 = fromNode.y + offsetY + nodeHeight / 2;
        const x2 = toNode.x + offsetX + nodeWidth / 2;
        const y2 = toNode.y + offsetY + nodeHeight / 2;

        let strokeWidth = 2;
        let strokeColor = '#666666';

        if (edge.weight !== undefined && maxAbsWeight > 0) {
            const normalizedMagnitude = Math.abs(edge.weight) / maxAbsWeight;
            strokeWidth = 2 + normalizedMagnitude * 6;
            strokeColor = getEdgeColor(edge.weight, minWeight, maxWeight);
        }

        svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${strokeColor}" stroke-width="${strokeWidth}" stroke-linecap="round"/>`;
    }
    svg += '</g>';

    // 5. Draw edge weight labels
    svg += '<g id="edge-labels">';
    for (const edge of edges) {
        if (edge.weight === undefined) continue;

        const fromNode = canvasNodes.find(n => n.id === edge.from);
        const toNode = canvasNodes.find(n => n.id === edge.to);
        if (!fromNode || !toNode) continue;

        const midX = (fromNode.x + toNode.x) / 2 + offsetX + nodeWidth / 2;
        const midY = (fromNode.y + toNode.y) / 2 + offsetY + nodeHeight / 2;

        svg += `<text x="${midX}" y="${midY - 8}" text-anchor="middle" font-size="10" fill="#333333" font-family="Arial, sans-serif">${edge.weight.toFixed(3)}</text>`;
    }
    svg += '</g>';

    // 6. Draw nodes (light colors)
    svg += '<g id="nodes">';
    for (const node of canvasNodes) {
        const x = node.x + offsetX;
        const y = node.y + offsetY;

        const bgColor = node.isSuper ? '#f0e8f8' : '#e8e8f0';
        const borderColor = node.isSuper ? '#7a5490' : '#3060a0';
        const textColor = node.isSuper ? '#5a3470' : '#1a1a2e';

        svg += `<rect x="${x}" y="${y}" width="${nodeWidth}" height="${nodeHeight}" rx="6" fill="${bgColor}" stroke="${borderColor}" stroke-width="2"/>`;

        let label;
        if (node.isSuper) {
            const latentIds = node.children.map(c => 'L' + (c.latentIdx + 1)).join(', ');
            label = latentIds;
        } else {
            label = `L${node.layer + 1}/${node.latentIdx + 1}`;
        }

        svg += `<text x="${x + nodeWidth/2}" y="${y + 20}" text-anchor="middle" font-size="12" font-weight="bold" fill="${textColor}" font-family="Arial, sans-serif">${label}</text>`;

        if (node.name) {
            svg += `<text x="${x + nodeWidth/2}" y="${y + 35}" text-anchor="middle" font-size="10" fill="#666666" font-family="Arial, sans-serif">${node.name}</text>`;
        } else if (node.isSuper) {
            svg += `<text x="${x + nodeWidth/2}" y="${y + 35}" text-anchor="middle" font-size="10" fill="#888888" font-family="Arial, sans-serif">Super Node (${node.children.length})</text>`;
        }
    }
    svg += '</g>';

    svg += '</svg>';

    // 7. Download
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `canvas-export-${Date.now()}.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function clearCanvas() {
    nodesContainer.innerHTML = '';
    canvasNodes = [];
    edges = [];
    selectedNodes.clear();
    selectedEdges.clear();
    edgesSvg.innerHTML = '';
}

function loadCanvasState(jsonText) {
    try {
        const state = JSON.parse(jsonText);

        if (!state.canvasNodes || !state.edges) {
            throw new Error('Invalid canvas state file');
        }

        clearCanvas();

        nodeIdCounter = state.nodeIdCounter || 0;
        edgeIdCounter = state.edgeIdCounter || 0;

        // First restore all nodes
        canvasNodes = state.canvasNodes;
        for (const node of canvasNodes) {
            renderNode(node);
        }

        // Restore user-created edges
        edges = state.edges;

        // Recreate virtual edges based on virtual weights data
        for (const node of canvasNodes) {
            if (!node.isSuper) {
                checkAndCreateVirtualEdges(node);
            }
        }

        updateEdges();

    } catch (err) {
        console.error('Error loading canvas state:', err);
        alert('Error loading canvas state. Please check the file format.');
    }
}

btnSaveCanvas.addEventListener('click', saveCanvasState);

const btnSaveSvg = document.getElementById('btn-save-svg');
btnSaveSvg.addEventListener('click', saveCanvasAsSVG);

btnLoadCanvas.addEventListener('click', () => {
    canvasFileInput.click();
});

canvasFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
        const text = await file.text();
        loadCanvasState(text);
        canvasFileInput.value = '';
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Ignore keyboard shortcuts when typing in an input field
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        return;
    }

    if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodes.size > 0 || selectedEdges.size > 0) {
            deleteSelected();
            e.preventDefault();
        }
    }
    if (e.key === 'Escape') {
        // Close panels first if open
        if (!layerPanel.classList.contains('hidden')) {
            layerPanel.classList.add('hidden');
        } else if (!activationPanel.classList.contains('hidden')) {
            activationPanel.classList.add('hidden');
        } else if (canvasSection.classList.contains('fullscreen')) {
            canvasSection.classList.remove('fullscreen');
            btnFullscreen.textContent = 'Fullscreen';
            setTimeout(updateEdges, 100);
        }
    }
});

// ============================================
// Virtual Weights Visualization (Grid-based)
// ============================================

const btnVirtualWeights = document.getElementById('btn-virtual-weights');
const gridEdgesSvg = document.getElementById('grid-edges-svg');
const edgeFilterControl = document.getElementById('edge-filter-control');
const edgeThresholdSlider = document.getElementById('edge-threshold-slider');
const edgeThresholdInput = document.getElementById('edge-threshold-input');

// Toggle virtual weights visibility
btnVirtualWeights.addEventListener('click', () => {
    if (!virtualWeightsData) return;

    virtualWeightsVisible = !virtualWeightsVisible;
    btnVirtualWeights.classList.toggle('active', virtualWeightsVisible);

    // Update button text and icon
    if (virtualWeightsVisible) {
        btnVirtualWeights.innerHTML = '<span class="btn-icon">👁</span> Hide virtual weights';
        edgeFilterControl.classList.remove('hidden');
        renderVirtualWeightsInGrid();
    } else {
        btnVirtualWeights.innerHTML = '<span class="btn-icon">👁</span> Show virtual weights';
        edgeFilterControl.classList.add('hidden');
        clearVirtualWeightsFromGrid();
    }
});

// Edge threshold slider handler
edgeThresholdSlider.addEventListener('input', () => {
    virtualWeightsThreshold = parseFloat(edgeThresholdSlider.value);
    edgeThresholdInput.value = virtualWeightsThreshold;
    if (virtualWeightsVisible) {
        renderVirtualWeightsInGrid();
    }
});

// Edge threshold input handler
edgeThresholdInput.addEventListener('input', () => {
    let value = parseFloat(edgeThresholdInput.value) || 0.01;
    value = Math.max(0.01, Math.min(100, value));
    virtualWeightsThreshold = value;
    edgeThresholdSlider.value = value;
    if (virtualWeightsVisible) {
        renderVirtualWeightsInGrid();
    }
});

// Clamp value on blur
edgeThresholdInput.addEventListener('blur', () => {
    let value = parseFloat(edgeThresholdInput.value) || 0.01;
    value = Math.max(0.01, Math.min(100, value));
    edgeThresholdInput.value = value;
    virtualWeightsThreshold = value;
    edgeThresholdSlider.value = value;
});

// Find latent box element in grid by layer, position, and feature
function findLatentBox(layer, pos, feature) {
    const selector = `.latent-box[data-layer="${layer}"][data-pos="${pos}"][data-latent="${feature}"]`;
    return gridBody.querySelector(selector);
}

// Get center position of an element relative to grid-container (visual position)
function getElementCenterInGrid(element) {
    const gridContainer = document.getElementById('grid-container');
    const containerRect = gridContainer.getBoundingClientRect();
    const elemRect = element.getBoundingClientRect();

    // Calculate visual position relative to grid-container (no scroll offset)
    return {
        x: elemRect.left - containerRect.left + elemRect.width / 2,
        y: elemRect.top - containerRect.top + elemRect.height / 2
    };
}

// Render virtual weights as edges in the grid
function renderVirtualWeightsInGrid() {
    clearVirtualWeightsFromGrid();

    if (!virtualWeightsData || virtualWeightsData.length === 0) return;

    // Filter edges based on threshold (top x% by absolute magnitude)
    let edgesToRender = virtualWeightsData;
    if (virtualWeightsThreshold < 100) {
        // Sort by absolute weight magnitude (descending)
        const sortedEdges = [...virtualWeightsData].sort((a, b) =>
            Math.abs(b[6]) - Math.abs(a[6])
        );
        // Calculate how many edges to keep
        const numToKeep = Math.ceil(sortedEdges.length * virtualWeightsThreshold / 100);
        edgesToRender = sortedEdges.slice(0, numToKeep);
    }

    // Find min/max weight for edge thickness scaling (from filtered edges)
    let minWeight = Infinity, maxWeight = -Infinity;
    for (const edge of edgesToRender) {
        const weight = edge[6];
        minWeight = Math.min(minWeight, weight);
        maxWeight = Math.max(maxWeight, weight);
    }

    // Create edges connecting latent boxes
    for (const edgeData of edgesToRender) {
        const [srcPos, srcLayer, srcFeature, tgtPos, tgtLayer, tgtFeature, weight] = edgeData;

        // Find the source and target latent boxes
        const srcBox = findLatentBox(srcLayer, srcPos, srcFeature);
        const tgtBox = findLatentBox(tgtLayer, tgtPos, tgtFeature);

        if (!srcBox || !tgtBox) {
            console.warn(`Could not find latent boxes for edge: L${srcLayer}/P${srcPos}/F${srcFeature} -> L${tgtLayer}/P${tgtPos}/F${tgtFeature}`);
            continue;
        }

        // Get positions
        const srcCenter = getElementCenterInGrid(srcBox);
        const tgtCenter = getElementCenterInGrid(tgtBox);

        // Calculate edge thickness based on weight magnitude (2px to 8px)
        const maxAbsWeight = Math.max(Math.abs(minWeight), Math.abs(maxWeight));
        const normalizedMagnitude = maxAbsWeight === 0 ? 0.5 : Math.abs(weight) / maxAbsWeight;
        const strokeWidth = 2 + normalizedMagnitude * 6;

        // Get color based on weight sign and magnitude (blue for negative, red for positive)
        const edgeColor = getEdgeColor(weight, minWeight, maxWeight);

        // Create SVG line
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', srcCenter.x);
        line.setAttribute('y1', srcCenter.y);
        line.setAttribute('x2', tgtCenter.x);
        line.setAttribute('y2', tgtCenter.y);
        line.setAttribute('stroke', edgeColor);
        line.setAttribute('stroke-width', strokeWidth);
        line.setAttribute('stroke-opacity', '0.5');
        line.setAttribute('stroke-linecap', 'round');
        line.classList.add('virtual-weight-edge');
        line.dataset.weight = weight.toFixed(3);
        line.dataset.color = edgeColor;
        line.dataset.srcLayer = srcLayer;
        line.dataset.srcPos = srcPos;
        line.dataset.srcFeature = srcFeature;
        line.dataset.tgtLayer = tgtLayer;
        line.dataset.tgtPos = tgtPos;
        line.dataset.tgtFeature = tgtFeature;

        // Add hover tooltip
        line.addEventListener('mouseenter', showGridEdgeTooltip);
        line.addEventListener('mouseleave', hideGridEdgeTooltip);
        line.addEventListener('mousemove', moveGridEdgeTooltip);

        // Highlight connected boxes on hover
        line.addEventListener('mouseenter', () => {
            srcBox.classList.add('edge-highlight');
            tgtBox.classList.add('edge-highlight');
        });
        line.addEventListener('mouseleave', () => {
            srcBox.classList.remove('edge-highlight');
            tgtBox.classList.remove('edge-highlight');
        });

        gridEdgesSvg.appendChild(line);
        virtualWeightsEdges.push({
            line,
            srcBox,
            tgtBox,
            srcLayer, srcPos, srcFeature,
            tgtLayer, tgtPos, tgtFeature,
            weight
        });
    }
}

// Clear virtual weights from grid
function clearVirtualWeightsFromGrid() {
    // Remove all edge lines
    gridEdgesSvg.innerHTML = '';
    virtualWeightsEdges = [];

    // Remove any highlights
    gridBody.querySelectorAll('.edge-highlight').forEach(el => {
        el.classList.remove('edge-highlight');
    });
}

// Update edge positions when grid scrolls
function updateGridEdgePositions() {
    if (!virtualWeightsVisible || virtualWeightsEdges.length === 0) return;

    for (const edge of virtualWeightsEdges) {
        const srcBox = findLatentBox(edge.srcLayer, edge.srcPos, edge.srcFeature);
        const tgtBox = findLatentBox(edge.tgtLayer, edge.tgtPos, edge.tgtFeature);

        if (srcBox && tgtBox) {
            const srcCenter = getElementCenterInGrid(srcBox);
            const tgtCenter = getElementCenterInGrid(tgtBox);

            edge.line.setAttribute('x1', srcCenter.x);
            edge.line.setAttribute('y1', srcCenter.y);
            edge.line.setAttribute('x2', tgtCenter.x);
            edge.line.setAttribute('y2', tgtCenter.y);
        }
    }
}

// Update edges when grid scrolls
gridBody.addEventListener('scroll', updateGridEdgePositions);

// Edge tooltip for grid
function createGridEdgeTooltip() {
    if (!gridEdgeTooltip) {
        gridEdgeTooltip = document.createElement('div');
        gridEdgeTooltip.className = 'edge-tooltip';
        gridEdgeTooltip.style.display = 'none';
        document.body.appendChild(gridEdgeTooltip);
    }
    return gridEdgeTooltip;
}

function showGridEdgeTooltip(e) {
    const tooltip = createGridEdgeTooltip();
    const weight = e.target.dataset.weight;
    const srcInfo = `L${parseInt(e.target.dataset.srcLayer) + 1}/P${parseInt(e.target.dataset.srcPos) + 1}/F${parseInt(e.target.dataset.srcFeature) + 1}`;
    const tgtInfo = `L${parseInt(e.target.dataset.tgtLayer) + 1}/P${parseInt(e.target.dataset.tgtPos) + 1}/F${parseInt(e.target.dataset.tgtFeature) + 1}`;

    tooltip.innerHTML = `
        <div class="edge-tooltip-weight">Weight: ${weight}</div>
        <div class="edge-tooltip-path">${srcInfo} → ${tgtInfo}</div>
    `;
    tooltip.style.display = 'block';

    const x = e.clientX + 15;
    const y = e.clientY - 40;
    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';

    // Highlight the edge
    e.target.setAttribute('stroke-opacity', '0.5');
    e.target.setAttribute('stroke', '#fff');
}

function hideGridEdgeTooltip(e) {
    if (gridEdgeTooltip) {
        gridEdgeTooltip.style.display = 'none';
    }
    // Restore edge style with original color
    e.target.setAttribute('stroke-opacity', '0.5');
    const originalColor = e.target.dataset.color || '#ff6b6b';
    e.target.setAttribute('stroke', originalColor);
}

function moveGridEdgeTooltip(e) {
    if (gridEdgeTooltip && gridEdgeTooltip.style.display !== 'none') {
        const x = e.clientX + 15;
        const y = e.clientY - 40;
        gridEdgeTooltip.style.left = x + 'px';
        gridEdgeTooltip.style.top = y + 'px';
    }
}

// ============================================
// Context Menu for Latent Elements
// ============================================

const contextMenu = document.getElementById('context-menu');
let contextMenuTarget = null;  // The element that was right-clicked
let contextMenuTargetType = null;  // 'canvas-node' or 'latent-box'
let contextMenuTargetData = null;  // Data about the target element

// Show context menu at given position
function showContextMenu(x, y) {
    // Show/hide menu items based on context type
    const addToCanvasItem = contextMenu.querySelector('[data-action="add-to-canvas"]');
    const addNameItem = contextMenu.querySelector('[data-action="add-name"]');

    // "Add Node to Canvas" only for latent-box (grid items)
    addToCanvasItem.style.display = contextMenuTargetType === 'latent-box' ? '' : 'none';
    // "Add Name" only for canvas-node
    addNameItem.style.display = contextMenuTargetType === 'canvas-node' ? '' : 'none';

    contextMenu.style.left = x + 'px';
    contextMenu.style.top = y + 'px';
    contextMenu.classList.remove('hidden');

    // Ensure menu stays within viewport
    const rect = contextMenu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        contextMenu.style.left = (window.innerWidth - rect.width - 10) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        contextMenu.style.top = (window.innerHeight - rect.height - 10) + 'px';
    }
}

// Hide context menu
function hideContextMenu() {
    contextMenu.classList.add('hidden');
    contextMenuTarget = null;
    contextMenuTargetType = null;
    contextMenuTargetData = null;
}

// Handle right-click on canvas nodes
nodesContainer.addEventListener('contextmenu', (e) => {
    const nodeEl = e.target.closest('.canvas-node');
    if (!nodeEl) return;

    e.preventDefault();

    const nodeId = parseInt(nodeEl.dataset.id);
    const node = canvasNodes.find(n => n.id === nodeId);

    if (node) {
        contextMenuTarget = nodeEl;
        contextMenuTargetType = 'canvas-node';
        contextMenuTargetData = node;
        showContextMenu(e.clientX, e.clientY);
    }
});

// Handle right-click on latent boxes in grid
gridBody.addEventListener('contextmenu', (e) => {
    const latentBox = e.target.closest('.latent-box');
    if (!latentBox) return;

    e.preventDefault();

    const layer = parseInt(latentBox.dataset.layer);
    const pos = parseInt(latentBox.dataset.pos);
    const latentIdx = parseInt(latentBox.dataset.latent);
    const value = parseFloat(latentBox.dataset.value);
    const aa = sequence[pos];

    contextMenuTarget = latentBox;
    contextMenuTargetType = 'latent-box';
    contextMenuTargetData = { layer, pos, latentIdx, value, aa };
    showContextMenu(e.clientX, e.clientY);
});

// Handle context menu item clicks
contextMenu.addEventListener('click', (e) => {
    const item = e.target.closest('.context-menu-item');
    if (!item) return;

    const action = item.dataset.action;

    if (action === 'delete') {
        handleContextMenuDelete();
    } else if (action === 'show-info') {
        handleContextMenuShowInfo();
    } else if (action === 'add-to-canvas') {
        handleContextMenuAddToCanvas();
    } else if (action === 'add-name') {
        handleContextMenuAddName();
    }

    hideContextMenu();
});

// Delete action handler
function handleContextMenuDelete() {
    if (contextMenuTargetType === 'canvas-node' && contextMenuTargetData) {
        // Delete the canvas node
        const nodeId = contextMenuTargetData.id;

        // Remove edges connected to this node
        edges = edges.filter(e => e.from !== nodeId && e.to !== nodeId);

        // Remove node from array
        const idx = canvasNodes.findIndex(n => n.id === nodeId);
        if (idx !== -1) canvasNodes.splice(idx, 1);

        // Remove DOM element
        if (contextMenuTarget) contextMenuTarget.remove();

        // Clear selection if this node was selected
        selectedNodes.delete(nodeId);

        // Update edges display
        updateEdges();
        updateSelectionUI();

    } else if (contextMenuTargetType === 'latent-box' && contextMenuTargetData) {
        // Find and delete the corresponding canvas node if it exists
        const { layer, latentIdx } = contextMenuTargetData;
        const node = findCanvasNode(layer, latentIdx);

        if (node) {
            const nodeId = node.id;

            // Remove edges connected to this node
            edges = edges.filter(e => e.from !== nodeId && e.to !== nodeId);

            // Remove node from array
            const idx = canvasNodes.findIndex(n => n.id === nodeId);
            if (idx !== -1) canvasNodes.splice(idx, 1);

            // Remove DOM element
            const nodeEl = nodesContainer.querySelector(`[data-id="${nodeId}"]`);
            if (nodeEl) nodeEl.remove();

            // Clear selection if this node was selected
            selectedNodes.delete(nodeId);

            // Update edges display
            updateEdges();
            updateSelectionUI();
        }
    }
}

// Show latent information action handler
function handleContextMenuShowInfo() {
    if (contextMenuTargetType === 'canvas-node' && contextMenuTargetData) {
        const node = contextMenuTargetData;

        if (node.isSuper) {
            // For super nodes, show info for the first child
            if (node.children && node.children.length > 0) {
                const child = node.children[0];
                const activations = getWildTypeActivations(child.layer, child.latentIdx);
                const maxIdx = findMaxActivationIndex(activations);
                const maxValue = activations[maxIdx] || 0;
                showActivationPanel(child.layer, child.latentIdx, maxIdx, maxValue);
            }
        } else {
            // For regular nodes, show activation panel
            showActivationPanel(node.layer, node.latentIdx, node.pos, node.value);
        }

    } else if (contextMenuTargetType === 'latent-box' && contextMenuTargetData) {
        const { layer, latentIdx, pos, value } = contextMenuTargetData;
        showActivationPanel(layer, latentIdx, pos, value);
    }
}

// Add to canvas action handler
function handleContextMenuAddToCanvas() {
    if (contextMenuTargetType === 'latent-box' && contextMenuTargetData) {
        const { layer, pos, latentIdx, value, aa } = contextMenuTargetData;
        addNodeToCanvas(latentIdx, layer, pos, aa, value);
    }
}

// Close context menu when clicking outside
document.addEventListener('click', (e) => {
    if (!contextMenu.contains(e.target)) {
        hideContextMenu();
    }
});

// Close context menu on Escape key (extend existing handler)
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !contextMenu.classList.contains('hidden')) {
        hideContextMenu();
        e.preventDefault();
        e.stopPropagation();
    }
}, true);  // Use capture phase to handle before other handlers

// ============================================
// Name Popup Functionality
// ============================================

let namePopupTargetNode = null;

function showNamePopup(node) {
    namePopupTargetNode = node;
    const popup = document.getElementById('name-popup');
    const input = document.getElementById('node-name-input');
    input.value = node.name || '';
    popup.classList.remove('hidden');
    input.focus();
}

function hideNamePopup() {
    const popup = document.getElementById('name-popup');
    popup.classList.add('hidden');
    namePopupTargetNode = null;
}

function handleContextMenuAddName() {
    if (contextMenuTargetType === 'canvas-node' && contextMenuTargetData) {
        showNamePopup(contextMenuTargetData);
    }
}

// Name popup event listeners
document.getElementById('name-popup-cancel').addEventListener('click', hideNamePopup);

document.getElementById('name-popup-save').addEventListener('click', () => {
    if (namePopupTargetNode) {
        const input = document.getElementById('node-name-input');
        namePopupTargetNode.name = input.value.trim();

        // Re-render the node
        const nodeEl = nodesContainer.querySelector(`[data-id="${namePopupTargetNode.id}"]`);
        if (nodeEl) {
            nodeEl.remove();
            renderNode(namePopupTargetNode);
        }
    }
    hideNamePopup();
});

// Keyboard shortcuts for name popup
document.getElementById('node-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('name-popup-save').click();
    } else if (e.key === 'Escape') {
        hideNamePopup();
    }
});

// Video guide popup
const videoPopup = document.getElementById('video-popup');
const videoIframe = document.getElementById('video-iframe');

document.getElementById('btn-guide').addEventListener('click', () => {
    videoIframe.src = 'https://www.youtube.com/embed/ruLcDtr_cGo?si=T4z5NIIE67f0o9-5&autoplay=1';
    videoPopup.classList.remove('hidden');
});

document.getElementById('btn-github').addEventListener('click', () => {
    window.open('https://github.com/amirgroup-codes/ProtoMech/tree/main', '_blank');
});

function closeVideoPopup() {
    videoPopup.classList.add('hidden');
    videoIframe.src = '';
}

document.getElementById('video-popup-close').addEventListener('click', closeVideoPopup);
videoPopup.addEventListener('click', (e) => {
    if (e.target === videoPopup) closeVideoPopup();
});
