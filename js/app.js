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
let positionOffset = 0;  // User-defined offset for amino acid position numbering
let gridEdgeTooltip = null;  // Tooltip for virtual weight edges

// CLM analysis state
let analysisType = 'zero-shot';  // 'CLM' | 'zero-shot'
let logitsData = null;            // Float32Array (rows * cols flat)
let logitsShape = null;           // [rows, cols]
let clmStart = 0;                 // position where <CLM>/<GLM> begins in fullSequence
let numGenerated = 0;             // generated.length
let topLogitsByPos = null;        // Map<pos, [{idx, value}, ...]> length 5
let markerLabel = '<CLM>';        // actual marker text from generation.fasta — '<CLM>' or '<GLM>'

// ProGen2 BPE vocab (indices 0-33). Indices outside this range render as "<id:N>".
const PROGEN2_VOCAB = [
    '<pad>', '<bos>', '<eos>', '<bos_glm>', '<eos_span>', '<mask>',
    '1', '2',
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L',
    'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V',
    'W', 'X', 'Y', 'Z'
];
function vocabToken(idx) {
    return PROGEN2_VOCAB[idx] !== undefined ? PROGEN2_VOCAB[idx] : `<id:${idx}>`;
}

// File upload state
let uploadedFiles = {
    activationIndices: null,
    fasta: null,
    logits: null,
    topActivations: null,
    virtualWeights: null
};
// Analysis type detected from the uploaded generation.fasta. Null until a fasta is dropped.
let detectedAnalysisType = null;
// Cached parse of the uploaded generation.fasta so btnLoad doesn't re-read the file.
let parsedUploadFasta = null;

// Upload screen elements
const uploadScreen = document.getElementById('upload-screen');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const btnLoad = document.getElementById('btn-load');
const statusActivation = document.getElementById('status-activation');
const statusTop = document.getElementById('status-top');
const statusVirtual = document.getElementById('status-virtual');
const statusFasta = document.getElementById('status-fasta');
const statusLogits = document.getElementById('status-logits');
const detectedAnalysisEl = document.getElementById('detected-analysis');
const detectedTypeEl = document.getElementById('detected-type');
const appContainer = document.getElementById('app');

// Example selector elements
const modelDropdown = document.getElementById('model-dropdown');
const analysisDropdown = document.getElementById('analysis-dropdown');
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

            // Parse CSV line (handle quoted values). 5 columns: id, name, path, model, analysis
            const match = line.match(/(\d+),\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)",\s*"([^"]+)"/);
            if (match) {
                examples.push({
                    id: match[1],
                    name: match[2],
                    path: match[3],
                    model: match[4],
                    analysis: match[5]
                });
            }
        }

        // Fetch sequence for each example to build the dropdown label.
        // generation.fasta is the unified sequence source for all analysis types.
        for (const example of examples) {
            try {
                const fastaResp = await fetch(example.path + 'generation.fasta');
                const fastaText = await fastaResp.text();
                const fasta = parseGenerationFasta(fastaText);
                example.sequence = fasta.fullSequence;
            } catch (err) {
                example.sequence = '';
            }
        }

        examplesData = examples;
        populateModelDropdown(examples);
        populateAnalysisDropdown();
        populateExampleDropdown();

        // Auto-load first example for the current model+analysis
        const filtered = getFilteredExamples();
        if (filtered.length > 0) {
            exampleDropdown.value = filtered[0].path;
            await loadExampleData(filtered[0].path);
        }
    } catch (err) {
        console.error('Error loading examples CSV:', err);
        exampleDropdown.innerHTML = '<option value="">No examples available</option>';
    }
}

// Populate model dropdown with unique model names (12-layer first)
function populateModelDropdown(examples) {
    const models = [...new Set(examples.map(e => e.model))];
    // Sort so higher layer count comes first
    models.sort((a, b) => {
        const aNum = parseInt(a.match(/(\d+)\s*layer/)?.[1] || '0');
        const bNum = parseInt(b.match(/(\d+)\s*layer/)?.[1] || '0');
        return bNum - aNum;
    });
    modelDropdown.innerHTML = '';
    for (const model of models) {
        const option = document.createElement('option');
        option.value = model;
        option.textContent = model;
        modelDropdown.appendChild(option);
    }
}

// Populate analysis dropdown with unique analysis values for the current model
function populateAnalysisDropdown() {
    const selectedModel = modelDropdown.value;
    // ESM models are zero-shot only, so the analysis dropdown is single-option noise
    analysisDropdown.style.display = selectedModel.includes('ESM') ? 'none' : '';
    const analyses = [...new Set(examplesData
        .filter(e => e.model === selectedModel)
        .map(e => e.analysis))];
    // Stable order: zero-shot first, then CLM, then GLM, then anything else
    const order = { 'zero-shot': 0, 'CLM': 1, 'GLM': 2 };
    analyses.sort((a, b) => (order[a] ?? 99) - (order[b] ?? 99) || a.localeCompare(b));
    const prev = analysisDropdown.value;
    analysisDropdown.innerHTML = '';
    for (const a of analyses) {
        const opt = document.createElement('option');
        opt.value = a;
        opt.textContent = a;
        analysisDropdown.appendChild(opt);
    }
    if (analyses.includes(prev)) analysisDropdown.value = prev;
}

// Get examples filtered by selected model and analysis
function getFilteredExamples() {
    const selectedModel = modelDropdown.value;
    const selectedAnalysis = analysisDropdown.value;
    return examplesData.filter(e =>
        e.model === selectedModel &&
        (!selectedAnalysis || e.analysis === selectedAnalysis)
    );
}

// Populate dropdown with examples filtered by current model + analysis
function populateExampleDropdown() {
    const filtered = getFilteredExamples();
    exampleDropdown.innerHTML = '<option value="">Select an example circuit...</option>';

    for (const example of filtered) {
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

// Load virtual weights, supporting both single-file and chunked formats
async function loadVirtualWeights(path) {
    try {
        const manifestResp = await fetch(path + 'virtual_weights_manifest.json');
        if (manifestResp.ok) {
            const manifest = await manifestResp.json();
            const parts = await Promise.all(
                Array.from({length: manifest.parts}, (_, i) =>
                    fetch(path + `virtual_weights_part${i}.json`).then(r => r.json())
                )
            );
            // Return already-parsed array directly
            return parts.flat();
        }
    } catch (e) {}
    return fetch(path + 'virtual_weights.json').then(r => r.ok ? r.text() : null).catch(() => null);
}

// Parse generation.fasta. Format:
//   >prompt
//   <prompt body, may contain "<CLM>" or "<GLM>" placeholder>
//   >generated_output
//   <generated tokens, or a score for zero-shot>
// Detection rule: <CLM> marker -> 'CLM'; <GLM> marker -> 'GLM'; neither -> 'zero-shot'.
// For zero-shot the >output section is a score (not residues), so the sequence is the prompt only.
function parseGenerationFasta(text) {
    const lines = text.split(/\r?\n/);
    let mode = null;
    const promptLines = [];
    const genLines = [];
    for (const line of lines) {
        if (line.startsWith('>prompt')) { mode = 'prompt'; continue; }
        if (line.startsWith('>generated_output') || line.startsWith('>output')) { mode = 'gen'; continue; }
        if (mode === 'prompt') promptLines.push(line);
        else if (mode === 'gen') genLines.push(line);
    }
    const promptWithMarker = promptLines.join('').trim();
    const rawGenerated = genLines.join('').trim();
    const markerMatch = promptWithMarker.match(/<(CLM|GLM)>/);
    if (!markerMatch) {
        // Zero-shot: prompt is the full sequence; >output is a score, not residues.
        return {
            type: 'zero-shot',
            promptWithMarker,
            prompt: promptWithMarker,
            generated: '',
            clmStart: promptWithMarker.length,
            fullSequence: promptWithMarker,
            marker: null
        };
    }
    const marker = markerMatch[0];
    const type = markerMatch[1];  // 'CLM' or 'GLM'
    const clmStart = markerMatch.index;
    const prompt = promptWithMarker.slice(0, clmStart) + promptWithMarker.slice(clmStart + marker.length);
    const fullSequence = prompt.slice(0, clmStart) + rawGenerated + prompt.slice(clmStart);
    return { type, promptWithMarker, prompt, generated: rawGenerated, clmStart, fullSequence, marker };
}

// Parse a NumPy v1.0 .npy file containing a 2D float32 array (dtype='<f4', C-order).
// Returns { shape: [rows, cols], data: Float32Array (length rows*cols) }.
function parseNpyFloat32(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    // Magic
    if (bytes[0] !== 0x93 || String.fromCharCode(bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]) !== 'NUMPY') {
        throw new Error('Not a .npy file (bad magic)');
    }
    const major = bytes[6];
    let headerLen, headerStart;
    if (major === 1) {
        headerLen = bytes[8] | (bytes[9] << 8);
        headerStart = 10;
    } else if (major === 2 || major === 3) {
        headerLen = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] << 24);
        headerStart = 12;
    } else {
        throw new Error('Unsupported .npy major version: ' + major);
    }
    const headerText = new TextDecoder('utf-8').decode(bytes.subarray(headerStart, headerStart + headerLen));
    const dataOffset = headerStart + headerLen;

    const descrMatch = headerText.match(/'descr':\s*'([^']+)'/);
    const fortranMatch = headerText.match(/'fortran_order':\s*(True|False)/);
    const shapeMatch = headerText.match(/'shape':\s*\(([^)]*)\)/);
    if (!descrMatch || !fortranMatch || !shapeMatch) {
        throw new Error('Malformed .npy header: ' + headerText);
    }
    if (descrMatch[1] !== '<f4') {
        throw new Error("Only dtype '<f4' (little-endian float32) is supported, got: " + descrMatch[1]);
    }
    if (fortranMatch[1] !== 'False') {
        throw new Error('Fortran-order arrays not supported');
    }
    const shape = shapeMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(s => s.length > 0)
        .map(s => parseInt(s, 10));
    if (shape.length !== 2) {
        throw new Error('Expected 2D logits array, got shape: (' + shape.join(', ') + ')');
    }
    const total = shape[0] * shape[1];
    // Float32Array constructor requires offset to be a multiple of 4. The .npy data
    // section can land on an unaligned offset (header is padded to a multiple of 64
    // for a total file alignment, but if hand-written this isn't guaranteed). Copy
    // to a fresh buffer if misaligned.
    let data;
    if (dataOffset % 4 === 0) {
        data = new Float32Array(arrayBuffer, dataOffset, total);
    } else {
        const copy = new ArrayBuffer(total * 4);
        new Uint8Array(copy).set(bytes.subarray(dataOffset, dataOffset + total * 4));
        data = new Float32Array(copy);
    }
    return { shape, data };
}

// Sort all entries of a numeric row descending; returns [{idx, value}, ...].
function rankAllLogits(row) {
    const ranked = new Array(row.length);
    for (let i = 0; i < row.length; i++) {
        ranked[i] = { idx: i, value: row[i] };
    }
    ranked.sort((a, b) => b.value - a.value);
    return ranked;
}

// Top-k indices/values from a numeric row, descending by value.
function computeTopK(row, k) {
    const top = [];  // ascending by value, length <= k
    for (let i = 0; i < row.length; i++) {
        const v = row[i];
        if (top.length < k) {
            top.push({ idx: i, value: v });
            // Insertion sort to keep ascending
            let j = top.length - 1;
            while (j > 0 && top[j - 1].value > top[j].value) {
                const tmp = top[j - 1]; top[j - 1] = top[j]; top[j] = tmp; j--;
            }
        } else if (v > top[0].value) {
            top[0] = { idx: i, value: v };
            let j = 0;
            while (j + 1 < top.length && top[j + 1].value < top[j].value) {
                const tmp = top[j + 1]; top[j + 1] = top[j]; top[j] = tmp; j++;
            }
        }
    }
    return top.reverse();  // descending
}

// Load example data from path
async function loadExampleData(path) {
    const loadingOverlay = document.getElementById('loading-overlay');
    loadingOverlay.classList.remove('hidden');
    try {
        // Reset state
        resetAppState();

        // Determine analysis type from the example record. GLM is treated the same as CLM downstream.
        const example = examplesData.find(e => e.path === path);
        analysisType = (example && (example.analysis === 'CLM' || example.analysis === 'GLM')) ? 'CLM' : 'zero-shot';

        // generation.fasta is now the unified sequence source for all analysis types.
        // logits.npy is only fetched for CLM/GLM.
        let activationsText, fastaText, topActivationsText, virtualWeightsText, canvasStateText, logitsBuf;
        const baseFetches = [
            fetch(path + 'activation_indices.json').then(r => r.text()),
            fetch(path + 'generation.fasta').then(r => r.text()),
            fetch(path + 'top_activations.json').then(r => r.text()),
            loadVirtualWeights(path),
            fetch(path + 'canvas-state.json').then(r => r.ok ? r.text() : null).catch(() => null)
        ];
        if (analysisType === 'CLM') {
            [activationsText, fastaText, topActivationsText, virtualWeightsText, canvasStateText, logitsBuf] = await Promise.all([
                ...baseFetches,
                fetch(path + 'logits.npy').then(r => r.arrayBuffer())
            ]);
        } else {
            [activationsText, fastaText, topActivationsText, virtualWeightsText, canvasStateText] = await Promise.all(baseFetches);
        }

        const activations = JSON.parse(activationsText);
        const fasta = parseGenerationFasta(fastaText);
        sequence = fasta.fullSequence;
        clmStart = fasta.clmStart;
        numGenerated = fasta.generated.length;
        markerLabel = fasta.marker || '<CLM>';
        if (analysisType === 'CLM') {
            const npy = parseNpyFloat32(logitsBuf);
            logitsData = npy.data;
            logitsShape = npy.shape;
            topLogitsByPos = new Map();
            const rows = Math.min(npy.shape[0], numGenerated);
            for (let i = 0; i < rows; i++) {
                const fullRow = npy.data.subarray(i * npy.shape[1], (i + 1) * npy.shape[1]);
                // Restrict to in-vocab indices (0..PROGEN2_VOCAB.length-1).
                const vocabRow = fullRow.subarray(0, Math.min(fullRow.length, PROGEN2_VOCAB.length));
                topLogitsByPos.set(clmStart + i, rankAllLogits(vocabRow));
            }
        }
        topActivationsData = JSON.parse(topActivationsText);

        // Parse virtual weights if present (may be pre-parsed array from chunked loading or text)
        if (virtualWeightsText) {
            virtualWeightsData = Array.isArray(virtualWeightsText) ? virtualWeightsText : JSON.parse(virtualWeightsText);
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
        renderLayerLabels();
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
    } finally {
        loadingOverlay.classList.add('hidden');
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
    analysisType = 'zero-shot';
    logitsData = null;
    logitsShape = null;
    clmStart = 0;
    numGenerated = 0;
    topLogitsByPos = null;
    markerLabel = '<CLM>';
    detectedAnalysisType = null;
    parsedUploadFasta = null;
    if (detectedAnalysisEl) detectedAnalysisEl.classList.add('hidden');

    // Clear canvas
    const nodesContainer = document.getElementById('nodes-container');
    const edgesSvg = document.getElementById('edges-svg');
    if (nodesContainer) nodesContainer.innerHTML = '';
    if (edgesSvg) edgesSvg.innerHTML = '';

    // Clear any virtual-weight edges still drawn over the grid from a prior example
    const gridEdgesSvg = document.getElementById('grid-edges-svg');
    if (gridEdgesSvg) gridEdgesSvg.innerHTML = '';

    // Reset virtual weights button state (class, label, and disabled)
    const btnVirtualWeights = document.getElementById('btn-virtual-weights');
    if (btnVirtualWeights) {
        btnVirtualWeights.classList.remove('active');
        btnVirtualWeights.innerHTML = '<span class="btn-icon">👁</span> Show virtual weights';
        btnVirtualWeights.disabled = true;
    }
    // Reset threshold to default; loadExampleData recomputes it for examples that have weights
    virtualWeightsThreshold = 10;
    const edgeSlider = document.getElementById('edge-threshold-slider');
    const edgeInput = document.getElementById('edge-threshold-input');
    if (edgeSlider) edgeSlider.value = virtualWeightsThreshold;
    if (edgeInput) edgeInput.value = virtualWeightsThreshold;

    // // Hide edge filter control
    // const edgeFilterControl = document.getElementById('edge-filter-control');
    // if (edgeFilterControl) {
    //     edgeFilterControl.classList.add('hidden');
    // }
}

// Handle model dropdown change
modelDropdown.addEventListener('change', async () => {
    populateAnalysisDropdown();
    populateExampleDropdown();
    const filtered = getFilteredExamples();
    if (filtered.length > 0) {
        exampleDropdown.value = filtered[0].path;
        await loadExampleData(filtered[0].path);
    }
});

// Handle analysis dropdown change
analysisDropdown.addEventListener('change', async () => {
    populateExampleDropdown();
    const filtered = getFilteredExamples();
    if (filtered.length > 0) {
        exampleDropdown.value = filtered[0].path;
        await loadExampleData(filtered[0].path);
    }
});

// Handle dropdown change
exampleDropdown.addEventListener('change', async (e) => {
    const path = e.target.value;
    if (path) {
        await loadExampleData(path);
    }
});

// Handle "Load Custom Circuit" button
function resetDropzoneStatuses() {
    for (const el of [statusActivation, statusTop, statusVirtual, statusFasta, statusLogits]) {
        if (!el) continue;
        el.classList.remove('loaded');
        const icon = el.querySelector('.status-icon');
        if (icon) icon.textContent = '○';
    }
}

// Show/hide the "Detected:" indicator based on the analysis type detected from
// the uploaded generation.fasta. The logits.npy row stays permanently visible
// (styled .optional) — it's only required by the Load button for CLM/GLM.
function applyDetectedAnalysis() {
    if (detectedAnalysisEl && detectedTypeEl) {
        if (detectedAnalysisType) {
            detectedTypeEl.textContent = detectedAnalysisType;
            detectedAnalysisEl.classList.remove('hidden');
        } else {
            detectedAnalysisEl.classList.add('hidden');
        }
    }
    updateLoadButton();
}

btnLoadCustom.addEventListener('click', () => {
    // Reset file upload state
    uploadedFiles = {
        activationIndices: null,
        fasta: null,
        logits: null,
        topActivations: null,
        virtualWeights: null
    };
    detectedAnalysisType = null;
    parsedUploadFasta = null;

    resetDropzoneStatuses();
    applyDetectedAnalysis();

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

async function handleFiles(files) {
    let fastaFile = null;
    for (const file of files) {
        const name = file.name.toLowerCase();

        if (name === 'activation_indices.json' || name.includes('activation_indices')) {
            uploadedFiles.activationIndices = file;
            statusActivation.classList.add('loaded');
            statusActivation.querySelector('.status-icon').textContent = '●';
        } else if (name === 'generation.fasta' || name.endsWith('.fasta') || name.includes('generation')) {
            uploadedFiles.fasta = file;
            fastaFile = file;
            if (statusFasta) {
                statusFasta.classList.add('loaded');
                statusFasta.querySelector('.status-icon').textContent = '●';
            }
        } else if (name === 'logits.npy' || name.endsWith('.npy') || name.includes('logits')) {
            uploadedFiles.logits = file;
            if (statusLogits) {
                statusLogits.classList.add('loaded');
                statusLogits.querySelector('.status-icon').textContent = '●';
            }
        } else if (name === 'top_activations.json' || name.includes('top_activations') || name.includes('top_activation')) {
            uploadedFiles.topActivations = file;
            statusTop.classList.add('loaded');
            statusTop.querySelector('.status-icon').textContent = '●';
        } else if (name === 'virtual_weights.json' || name.includes('virtual_weights')) {
            uploadedFiles.virtualWeights = file;
            statusVirtual.classList.add('loaded');
            statusVirtual.querySelector('.status-icon').textContent = '●';
        }
    }

    if (fastaFile) {
        try {
            const text = await fastaFile.text();
            parsedUploadFasta = parseGenerationFasta(text);
            detectedAnalysisType = parsedUploadFasta.type;
        } catch (err) {
            console.error('Error reading generation.fasta:', err);
            parsedUploadFasta = null;
            detectedAnalysisType = null;
        }
    }

    applyDetectedAnalysis();
}

function updateLoadButton() {
    const baseLoaded = uploadedFiles.activationIndices
        && uploadedFiles.fasta
        && uploadedFiles.topActivations
        && uploadedFiles.virtualWeights;
    const causalReady = detectedAnalysisType === 'zero-shot'
        || ((detectedAnalysisType === 'CLM' || detectedAnalysisType === 'GLM') && uploadedFiles.logits);
    btnLoad.disabled = !(baseLoaded && detectedAnalysisType && causalReady);
}

btnLoad.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (btnLoad.disabled) return;

    const loadingOverlay = document.getElementById('loading-overlay');
    try {
        btnLoad.textContent = 'Loading...';
        btnLoad.disabled = true;
        loadingOverlay.classList.remove('hidden');

        // Snapshot state needed to restore after resetAppState() wipes module globals.
        const detected = detectedAnalysisType;
        const fasta = parsedUploadFasta;

        // Reset app state for fresh load
        resetAppState();
        // GLM is treated identically to CLM downstream; the marker label distinguishes them visually.
        analysisType = (detected === 'GLM' || detected === 'CLM') ? 'CLM' : 'zero-shot';

        // Clear dropdown selection (custom circuit)
        exampleDropdown.value = '';

        // Read all required files
        const [activationsText, topActivationsText, virtualWeightsText, logitsBuf] = await Promise.all([
            uploadedFiles.activationIndices.text(),
            uploadedFiles.topActivations.text(),
            uploadedFiles.virtualWeights.text(),
            (analysisType === 'CLM' && uploadedFiles.logits)
                ? uploadedFiles.logits.arrayBuffer()
                : Promise.resolve(null)
        ]);

        const activations = JSON.parse(activationsText);
        sequence = fasta.fullSequence;
        clmStart = fasta.clmStart;
        numGenerated = fasta.generated.length;
        markerLabel = fasta.marker || '<CLM>';
        if (analysisType === 'CLM') {
            const npy = parseNpyFloat32(logitsBuf);
            logitsData = npy.data;
            logitsShape = npy.shape;
            topLogitsByPos = new Map();
            const rows = Math.min(npy.shape[0], numGenerated);
            for (let i = 0; i < rows; i++) {
                const fullRow = npy.data.subarray(i * npy.shape[1], (i + 1) * npy.shape[1]);
                // Restrict to in-vocab indices (0..PROGEN2_VOCAB.length-1).
                const vocabRow = fullRow.subarray(0, Math.min(fullRow.length, PROGEN2_VOCAB.length));
                topLogitsByPos.set(clmStart + i, rankAllLogits(vocabRow));
            }
        }
        topActivationsData = JSON.parse(topActivationsText);

        // Parse virtual weights if present
        if (virtualWeightsText) {
            virtualWeightsData = JSON.parse(virtualWeightsText);
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
        renderLayerLabels();
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
    } finally {
        loadingOverlay.classList.add('hidden');
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

// Number of model layers. Authoritative: `num_layers` in top_activations.json.
// Falls back to max(activationData layer index)+1 for files that pre-date the
// field — without that fallback, sparse activation data silently under-renders
// (e.g. kinase_zeroshot has activations only for layers [0,7,8,9] but the
// model has 10 layers, so layers 7–9 must still render).
function getNumLayers() {
    if (topActivationsData && Number.isInteger(topActivationsData.num_layers)) {
        return topActivationsData.num_layers;
    }
    const keys = Object.keys(activationData);
    if (keys.length === 0) return 0;
    let max = -1;
    for (const k of keys) { const n = +k; if (n > max) max = n; }
    return max + 1;
}

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

// Render layer labels dynamically based on loaded data
function renderLayerLabels() {
    const numLayers = getNumLayers();
    const layerLabelsContainer = document.getElementById('layer-labels');
    let html = '';
    if (analysisType === 'CLM' && topLogitsByPos) {
        html += `<div class="layer-label layer-label-lgt" data-layer="lgt">lgt</div>`;
    }
    for (let layer = numLayers - 1; layer >= 0; layer--) {
        html += `<div class="layer-label" data-layer="${layer}">Layer ${layer + 1}</div>`;
    }
    layerLabelsContainer.innerHTML = html;

    // Attach click handlers (skip lgt — no per-layer panel for it)
    layerLabelsContainer.querySelectorAll('.layer-label').forEach(label => {
        if (label.dataset.layer === 'lgt') return;
        label.addEventListener('click', () => {
            const layer = parseInt(label.dataset.layer);
            showLayerPanel(layer);
        });
    });
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

    const numLayers = getNumLayers();
    for (let layer = 0; layer < numLayers; layer++) {
        for (let pos = 0; pos < numPositions; pos++) {
            // activationData is indexed by logical position; collapse generated columns
            // onto the marker and shift post-marker columns back so each fullSequence
            // column reads its corresponding logical entry.
            const items = activationData[layer]?.[logicalPos(pos)] || [];
            maxLatentsPerPos[pos] = Math.max(maxLatentsPerPos[pos], items.length);
        }
    }
    // Account for top-5 logit boxes in the lgt row at generated positions.
    if (analysisType === 'CLM' && topLogitsByPos) {
        for (const pos of topLogitsByPos.keys()) {
            if (pos >= 0 && pos < numPositions) {
                maxLatentsPerPos[pos] = Math.max(maxLatentsPerPos[pos], 2);
            }
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
    const numLayers = getNumLayers();

    // CLM: lgt row at the top, only populated at generated positions.
    if (analysisType === 'CLM' && topLogitsByPos) {
        html += `<div class="grid-row grid-row-lgt" data-layer="lgt">`;
        for (let pos = 0; pos < numPositions; pos++) {
            const cellWidth = Math.max(minCellWidth, maxLatentsPerPos[pos] * boxWidth + cellPaddingAndBorder);
            html += `<div class="grid-cell" data-layer="lgt" data-pos="${pos}" style="width: ${cellWidth}px; min-width: ${cellWidth}px;">`;
            const ranked = topLogitsByPos.get(pos);
            if (ranked && ranked.length > 0) {
                const top2 = ranked.slice(0, 2);
                // Color scale spans the top-2 themselves so rank 1 always reads "hot"
                const maxV = top2[0].value;
                const minV = top2[top2.length - 1].value;
                const span = Math.max(1e-9, maxV - minV);
                for (let r = 0; r < top2.length; r++) {
                    const { idx, value } = top2[r];
                    const tok = vocabToken(idx);
                    const tokSafe = escapeHtml(tok);
                    const color = getActivationColor(value, minV, maxV);
                    const t = (value - minV) / span;
                    const textColor = (t > 0.15 && t < 0.85) ? '#000' : '#fff';
                    html += `<div class="latent-box logit-box"
                        data-layer="lgt"
                        data-pos="${pos}"
                        data-rank="${r}"
                        data-token-idx="${idx}"
                        data-value="${value.toFixed(3)}"
                        style="background: ${color}; color: ${textColor}"
                        title="rank ${r + 1}: ${tokSafe} (${value.toFixed(3)})"
                    >${tokSafe}</div>`;
                }
            }
            html += '</div>';
        }
        html += '</div>';
    }

    // Each row is a layer (reversed: top to 0)
    for (let layer = numLayers - 1; layer >= 0; layer--) {
        html += `<div class="grid-row" data-layer="${layer}">`;
        // Each column is a position
        for (let pos = 0; pos < numPositions; pos++) {
            const cellWidth = Math.max(minCellWidth, maxLatentsPerPos[pos] * boxWidth + cellPaddingAndBorder);
            html += `<div class="grid-cell" data-layer="${layer}" data-pos="${pos}" style="width: ${cellWidth}px; min-width: ${cellWidth}px;">`;
            const items = activationData[layer]?.[logicalPos(pos)] || [];
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

    // Add click handlers — distinguish latent vs logit boxes
    gridBody.querySelectorAll('.latent-box').forEach(box => {
        if (box.classList.contains('logit-box')) {
            box.addEventListener('click', handleLogitClick);
        } else {
            box.addEventListener('click', handleLatentClick);
        }
    });
}

// Render sequence bar
function renderSequence() {
    let html = '';
    const widths = window.columnWidths || [];
    for (let i = 0; i < sequence.length; i++) {
        const width = widths[i] || 36;
        const isGenerated = analysisType === 'CLM' &&
            i >= clmStart && i < clmStart + numGenerated;
        const cls = 'seq-item' + (isGenerated ? ' seq-item-generated' : '');
        const label = isGenerated ? escapeHtml(markerLabel) : sequence[i];
        html += `<div class="${cls}" data-pos="${i}" style="width: ${width}px; min-width: ${width}px;">
            <span class="seq-aa">${label}</span>
            <span class="seq-pos">${displayPos(i)}</span>
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
        // activations is keyed by logical pos (matches activationData / activation_indices.json).
        const activation = activations[logicalPos(i)] || 0;
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
                    <span class="clicked-pos">Position ${displayPos(clickedPos)}</span>
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

// Handle a click on a logit box in the lgt row
function handleLogitClick(e) {
    const target = e.currentTarget;
    const pos = parseInt(target.dataset.pos);
    showLogitsPanel(pos);
}

// State for the logits panel (tabs + token drill-down)
let currentLogitsPos = null;
let currentLogitsTab = 'ranked';      // 'ranked' | 'incoming'
let selectedLogitTokenIdx = null;     // set when user clicks a row in the ranked table

// Show the logits panel for a generated position. Defaults to the "All ranked" tab.
function showLogitsPanel(pos) {
    const ranked = topLogitsByPos && topLogitsByPos.get(pos);
    if (!ranked || ranked.length === 0) return;

    currentPanelState = null;  // logits panel has no latent context
    currentLogitsPos = pos;
    currentLogitsTab = 'ranked';
    selectedLogitTokenIdx = null;

    panelTitle.textContent = `Logits @ position ${displayPos(pos)}`;

    // Hide the "Add to Canvas" button if it exists — not meaningful for logits
    const addBtn = document.getElementById('panel-add-to-canvas');
    if (addBtn) addBtn.style.display = 'none';

    renderLogitsPanel();
    activationPanel.classList.remove('hidden');
}

// Re-renders #activation-panel-content for the current logits-panel state.
function renderLogitsPanel() {
    const pos = currentLogitsPos;
    const ranked = topLogitsByPos.get(pos);

    let html = '<div class="logit-panel">';

    // Tab bar
    html += '<div class="logit-tabs">';
    html += `<button class="logit-tab ${currentLogitsTab === 'ranked' ? 'active' : ''}" data-tab="ranked">All ranked</button>`;
    if (selectedLogitTokenIdx !== null) {
        const tok = vocabToken(selectedLogitTokenIdx);
        html += `<button class="logit-tab ${currentLogitsTab === 'incoming' ? 'active' : ''}" data-tab="incoming">Incoming → ${escapeHtml(tok)}</button>`;
    }
    html += '</div>';

    if (currentLogitsTab === 'incoming' && selectedLogitTokenIdx !== null) {
        html += renderLogitsIncomingTab(pos, selectedLogitTokenIdx);
    } else {
        html += renderLogitsRankedTab(ranked, pos);
    }

    html += '</div>';
    panelContent.innerHTML = html;

    // Wire tab clicks
    panelContent.querySelectorAll('.logit-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            currentLogitsTab = btn.dataset.tab;
            renderLogitsPanel();
        });
    });

    // Wire row clicks in the ranked table — drill into the incoming-edges tab
    panelContent.querySelectorAll('tr.logit-row[data-token-idx]').forEach(row => {
        row.addEventListener('click', () => {
            selectedLogitTokenIdx = parseInt(row.dataset.tokenIdx);
            currentLogitsTab = 'incoming';
            renderLogitsPanel();
        });
    });

    // Wire per-row "Add to canvas" buttons — must not bubble into row click
    panelContent.querySelectorAll('.btn-add-logit-to-canvas').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const tokenIdx = parseInt(btn.dataset.tokenIdx);
            const value = parseFloat(btn.dataset.value);
            addLogitNodeToCanvas(currentLogitsPos, tokenIdx, value);
        });
    });
}

function renderLogitsRankedTab(ranked, pos) {
    const maxV = ranked[0].value;
    const minV = ranked[ranked.length - 1].value;
    const span = Math.max(1e-9, maxV - minV);

    let html = `<div class="logit-panel-context">
        Position <strong>${displayPos(pos)}</strong>
        &middot; generated token: <strong>${escapeHtml(sequence[pos] ?? '?')}</strong>
        &middot; <span class="logit-count">${ranked.length} ranked</span>
        &middot; <em>click a row to see incoming edges</em>
    </div>`;
    html += '<table class="logit-table"><thead><tr>' +
            '<th>Rank</th><th>Token</th><th>Idx</th><th>Logit</th><th></th><th></th>' +
            '</tr></thead><tbody>';
    for (let r = 0; r < ranked.length; r++) {
        const { idx, value } = ranked[r];
        const tok = vocabToken(idx);
        const barPct = ((value - minV) / span) * 100;
        const color = getActivationColor(value, minV, maxV);
        html += `<tr class="logit-row" data-token-idx="${idx}">
            <td class="logit-rank">${r + 1}</td>
            <td class="logit-token">${escapeHtml(tok)}</td>
            <td class="logit-idx">${idx}</td>
            <td class="logit-value">${value.toFixed(3)}</td>
            <td class="logit-bar-cell">
                <div class="logit-bar-track">
                    <div class="logit-bar-fill" style="width: ${barPct.toFixed(1)}%; background: ${color};"></div>
                </div>
            </td>
            <td class="logit-add-cell">
                <button class="btn-add-logit-to-canvas" data-token-idx="${idx}" data-value="${value}">Add to canvas</button>
            </td>
        </tr>`;
    }
    html += '</tbody></table>';
    return html;
}

function renderLogitsIncomingTab(pos, tokenIdx) {
    const tok = vocabToken(tokenIdx);
    const edges = getIncomingLogitEdges(pos, tokenIdx);

    let html = `<div class="logit-panel-context">
        Incoming virtual-weight edges to <strong>${escapeHtml(tok)}</strong>
        @ position <strong>${displayPos(pos)}</strong>
        &middot; <span class="logit-count">${edges.length} edge${edges.length === 1 ? '' : 's'}</span>
    </div>`;

    if (edges.length === 0) {
        html += `<div class="no-data-message">No virtual-weight edges target this token.</div>`;
        return html;
    }

    const maxAbs = Math.max(...edges.map(e => Math.abs(e.weight)));
    const span = Math.max(1e-9, maxAbs);

    html += '<table class="logit-table incoming-edges"><thead><tr>' +
            '<th>Rank</th><th>Src Pos</th><th>Src Layer</th><th>Src Latent</th><th>Weight</th><th></th>' +
            '</tr></thead><tbody>';
    for (let r = 0; r < edges.length; r++) {
        const e = edges[r];
        const barPct = (Math.abs(e.weight) / span) * 100;
        const color = e.weight >= 0 ? '#dc2626' : '#2563eb';  // red positive, blue negative (matches grid edges)
        html += `<tr>
            <td class="logit-rank">${r + 1}</td>
            <td>${displayPos(e.srcPos)}</td>
            <td>L${e.srcLayer + 1}</td>
            <td>${e.srcFeature + 1}</td>
            <td class="logit-value">${e.weight.toFixed(3)}</td>
            <td class="logit-bar-cell">
                <div class="logit-bar-track">
                    <div class="logit-bar-fill" style="width: ${barPct.toFixed(1)}%; background: ${color};"></div>
                </div>
            </td>
        </tr>`;
    }
    html += '</tbody></table>';
    return html;
}

// Minimal HTML-escape for vocab tokens like "<pad>", "<bos>" that include angle brackets.
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

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
    addBtn.style.display = '';  // restore in case it was hidden by the lgt panel

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

// Get virtual-weight edges incoming to a specific (clmPos, lgt-layer, tokenIdx) target.
// Returns array of { srcPos, srcLayer, srcFeature, weight } sorted by |weight| desc.
// Operates on the raw virtualWeightsData (positional), not the aggregated map.
function getIncomingLogitEdges(clmPos, tokenIdx) {
    if (!virtualWeightsData) return [];
    const numLayers = getNumLayers();
    const out = [];
    for (const [srcPos, srcLayer, srcFeature, tgtPos, tgtLayer, tgtFeature, weight] of virtualWeightsData) {
        if (tgtPos === clmPos && tgtLayer === numLayers && tgtFeature === tokenIdx) {
            out.push({ srcPos, srcLayer, srcFeature, weight });
        }
    }
    out.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
    return out;
}

// Get virtual-weight edges outgoing from a specific (srcLayer, srcFeature) latent to the
// logits layer, aggregated per (tgtPos, tgtFeature) across all source positions.
// Returns array of { tgtPos, tgtFeature, avgWeight, count } sorted by |avgWeight| desc.
function getOutgoingLogitEdges(srcLayer, srcFeature) {
    if (!virtualWeightsData) return [];
    const numLayers = getNumLayers();
    const map = new Map();
    for (const [srcPos, sLayer, sFeature, tgtPos, tgtLayer, tgtFeature, weight] of virtualWeightsData) {
        if (sLayer === srcLayer && sFeature === srcFeature && tgtLayer === numLayers) {
            const key = `${tgtPos}-${tgtFeature}`;
            let entry = map.get(key);
            if (!entry) {
                entry = { tgtPos, tgtFeature, totalWeight: 0, count: 0 };
                map.set(key, entry);
            }
            entry.totalWeight += weight;
            entry.count += 1;
        }
    }
    const out = [];
    for (const e of map.values()) {
        out.push({ tgtPos: e.tgtPos, tgtFeature: e.tgtFeature, avgWeight: e.totalWeight / e.count, count: e.count });
    }
    out.sort((a, b) => Math.abs(b.avgWeight) - Math.abs(a.avgWeight));
    return out;
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
                    const maxIdx = findMaxActivationIndex(item.Activations, item.Sequence.length);
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
    const numLayers = getNumLayers();
    const isLastLayer = layer === numLayers - 1;
    const isCLM = analysisType === 'CLM';

    // For CLM/GLM, edges to the logits "layer" (tgtLayer === numLayers) need positional info
    // (one row per (tgtPos, tgtFeature)), so drop the position-collapsed entries that
    // getOutgoingEdges returns for them and replace with positional rows.
    let regularEdges = getOutgoingEdges(layer, latentIdx);
    let logitRows = [];
    if (isCLM) {
        regularEdges = regularEdges.filter(e => e.tgtLayer < numLayers);
        logitRows = getOutgoingLogitEdges(layer, latentIdx);
    }

    const allRows = [
        ...regularEdges.map(e => ({ ...e, isLogit: false })),
        ...logitRows.map(e => ({
            tgtLayer: numLayers,
            tgtPos: e.tgtPos,
            tgtFeature: e.tgtFeature,
            avgWeight: e.avgWeight,
            count: e.count,
            isLogit: true,
        })),
    ];
    allRows.sort((a, b) => Math.abs(b.avgWeight) - Math.abs(a.avgWeight));

    // Header info
    html += `
        <div class="influences-header">
            <div class="influences-summary">
                <span class="influences-count">${allRows.length} outgoing connection${allRows.length !== 1 ? 's' : ''}</span>
                <span class="influences-target">from Layer ${layer + 1}, Latent ${latentIdx + 1}</span>
            </div>
        </div>
    `;

    if (allRows.length === 0) {
        if (isLastLayer && !isCLM) {
            html += '<div class="no-data-message">This is the final layer - no outgoing influences.</div>';
        } else if (!virtualWeightsData) {
            html += '<div class="no-data-message">Virtual weights data not loaded. Upload virtual_weights.json to see influences.</div>';
        } else {
            html += '<div class="no-data-message">No outgoing influences found for this latent.</div>';
        }
    } else {
        // Calculate min/max for color scaling (across both regular and logit rows)
        const weights = allRows.map(e => e.avgWeight);
        const minWeight = Math.min(...weights);
        const maxWeight = Math.max(...weights);

        html += '<div class="influences-list">';

        allRows.forEach((edge, index) => {
            const weightSign = edge.avgWeight >= 0 ? 'positive' : 'negative';
            const weightColor = getEdgeColor(edge.avgWeight, minWeight, maxWeight);

            if (edge.isLogit) {
                const label = `lgt/${escapeHtml(vocabToken(edge.tgtFeature))}${displayPos(edge.tgtPos)}`;
                html += `
                    <div class="influence-card"
                         data-is-logit="1"
                         data-tgt-pos="${edge.tgtPos}"
                         data-tgt-token-idx="${edge.tgtFeature}"
                         data-direction="outgoing">
                        <div class="influence-rank">#${index + 1}</div>
                        <div class="influence-source">
                            <span class="influence-layer">${label}</span>
                        </div>
                        <div class="influence-weight ${weightSign}" style="background: ${weightColor}">
                            ${edge.avgWeight >= 0 ? '+' : ''}${edge.avgWeight.toFixed(4)}
                        </div>
                        <div class="influence-meta">
                            <span class="influence-edge-count">${edge.count} edge${edge.count !== 1 ? 's' : ''}</span>
                        </div>
                        <button class="btn-view-source" title="View logits panel">View</button>
                    </div>
                `;
            } else {
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
            }
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

                if (direction === 'outgoing' && card.dataset.isLogit === '1') {
                    showLogitsPanel(parseInt(card.dataset.tgtPos));
                    return;
                }

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
function findMaxActivationIndex(activations, maxLength) {
    let maxVal = -Infinity;
    let maxIdx = 0;
    const len = maxLength || activations.length;
    for (let i = 0; i < len; i++) {
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
                        <span class="latent-rank-pos">@ Pos ${displayPos(maxPos)} (${aa})</span>
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

// Add a logit (output-vocab) node to the canvas. The "logit layer" index matches
// the convention used by virtual_weights.json (numLayers, e.g. 10), so the
// existing checkAndCreateVirtualEdges lookup picks up latent→logit edges.
function addLogitNodeToCanvas(pos, tokenIdx, value) {
    const logitLayer = getNumLayers();
    return addNodeToCanvas(tokenIdx, logitLayer, pos, vocabToken(tokenIdx), value);
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
        const isLogit = analysisType === 'CLM' && node.layer === getNumLayers();
        const label = isLogit
            ? `lgt/${escapeHtml(vocabToken(node.latentIdx))}${displayPos(node.pos)}`
            : `L${node.layer + 1}/${node.latentIdx + 1}`;
        div.innerHTML = `
            <div class="node-latent">${label}</div>
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

// Position offset control.
// In CLM/GLM mode the marker is one logical slot but is rendered as N grid columns
// (one per generated token). logicalPos collapses generated columns onto the marker
// and shifts post-marker columns back, so positions match activation_indices.json.
function logicalPos(i) {
    if (analysisType !== 'CLM' || numGenerated <= 0) return i;
    if (i < clmStart) return i;
    if (i < clmStart + numGenerated) return clmStart;
    return i - (numGenerated - 1);
}
function displayPos(pos) {
    if (analysisType === 'CLM' && numGenerated > 0 &&
        pos >= clmStart && pos < clmStart + numGenerated) {
        return pos + 1 + positionOffset;
    }
    return logicalPos(pos) + 1 + positionOffset;
}

const offsetInput = document.getElementById('offset-input');
offsetInput.addEventListener('input', () => {
    positionOffset = parseInt(offsetInput.value) || 0;
    renderSequence();
});

// Settings popup toggle
const settingsPopup = document.getElementById('settings-popup');
document.getElementById('btn-settings').addEventListener('click', () => {
    settingsPopup.classList.remove('hidden');
});
document.getElementById('settings-popup-close').addEventListener('click', () => {
    settingsPopup.classList.add('hidden');
});
settingsPopup.addEventListener('click', (e) => {
    if (e.target === settingsPopup) settingsPopup.classList.add('hidden');
});

const btnVirtualWeights = document.getElementById('btn-virtual-weights');
const gridEdgesSvg = document.getElementById('grid-edges-svg');
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
        renderVirtualWeightsInGrid();
    } else {
        btnVirtualWeights.innerHTML = '<span class="btn-icon">👁</span> Show virtual weights';
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
    // lgt layer: target specific token box if it's in the visible top-2,
    // otherwise fall back to the lgt cell itself.
    const numLayers = getNumLayers();
    if (analysisType === 'CLM' && layer === numLayers) {
        const tokenBox = gridBody.querySelector(
            `.logit-box[data-layer="lgt"][data-pos="${pos}"][data-token-idx="${feature}"]`
        );
        if (tokenBox) return tokenBox;
        return gridBody.querySelector(`.grid-cell[data-layer="lgt"][data-pos="${pos}"]`);
    }
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

    // Split edges: those targeting the lgt layer get a separate top-5-per-position cap
    // (real CLM data will have many srcs per logit, so we never want to flood the grid).
    const numLayers = getNumLayers();
    const lgtEdges = [];
    const otherEdges = [];
    for (const e of virtualWeightsData) {
        if (analysisType === 'CLM' && e[4] === numLayers) lgtEdges.push(e);
        else otherEdges.push(e);
    }

    // Apply the % threshold to non-lgt edges (existing behaviour)
    let filteredOther = otherEdges;
    if (virtualWeightsThreshold < 100 && otherEdges.length) {
        const sorted = [...otherEdges].sort((a, b) => Math.abs(b[6]) - Math.abs(a[6]));
        const numToKeep = Math.ceil(sorted.length * virtualWeightsThreshold / 100);
        filteredOther = sorted.slice(0, numToKeep);
    }

    // Cap lgt edges at top-5 per <CLM> position by absolute weight
    const byLgtPos = new Map();
    for (const e of lgtEdges) {
        const tgtPos = e[3];
        if (!byLgtPos.has(tgtPos)) byLgtPos.set(tgtPos, []);
        byLgtPos.get(tgtPos).push(e);
    }
    const cappedLgt = [];
    for (const arr of byLgtPos.values()) {
        arr.sort((a, b) => Math.abs(b[6]) - Math.abs(a[6]));
        cappedLgt.push(...arr.slice(0, 5));
    }

    const edgesToRender = filteredOther.concat(cappedLgt);

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
    const srcInfo = `L${parseInt(e.target.dataset.srcLayer) + 1}/P${displayPos(parseInt(e.target.dataset.srcPos))}/F${parseInt(e.target.dataset.srcFeature) + 1}`;
    const tgtInfo = `L${parseInt(e.target.dataset.tgtLayer) + 1}/P${displayPos(parseInt(e.target.dataset.tgtPos))}/F${parseInt(e.target.dataset.tgtFeature) + 1}`;

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

    const isLogit = latentBox.classList.contains('logit-box');
    const pos = parseInt(latentBox.dataset.pos);
    const value = parseFloat(latentBox.dataset.value);
    const layer = isLogit ? getNumLayers() : parseInt(latentBox.dataset.layer);
    const latentIdx = isLogit
        ? parseInt(latentBox.dataset.tokenIdx)
        : parseInt(latentBox.dataset.latent);
    const aa = isLogit ? vocabToken(latentIdx) : sequence[pos];

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
    videoIframe.src = 'https://www.youtube.com/embed/wF6xUQDxu1w?autoplay=1';
    videoPopup.classList.remove('hidden');
});

function closeVideoPopup() {
    videoPopup.classList.add('hidden');
    videoIframe.src = '';
}

document.getElementById('video-popup-close').addEventListener('click', closeVideoPopup);
videoPopup.addEventListener('click', (e) => {
    if (e.target === videoPopup) closeVideoPopup();
});

// Paper/Code links depend on the selected model:
//   ProGen3 examples -> ProGenMech (MechInterp Workshop, ICML 2026)
//   ESM examples     -> ProtoMech (ICML 2026)
function getProjectLinks() {
    const isProGen = modelDropdown.value.includes('ProGen');
    return isProGen
        ? {
            paper: 'https://openreview.net/pdf?id=9xHiruDoj7',
            code: 'https://github.com/amirgroup-codes/ProGenMech'
        }
        : {
            paper: 'https://arxiv.org/pdf/2602.12026',
            code: 'https://github.com/amirgroup-codes/ProtoMech/tree/main'
        };
}

document.getElementById('btn-arxiv').addEventListener('click', () => {
    window.open(getProjectLinks().paper, '_blank');
});

document.getElementById('btn-github').addEventListener('click', () => {
    window.open(getProjectLinks().code, '_blank');
});