// Function to update the custom color and save it in local storage
function applyColor() {
    const r = document.getElementById('website-color-r').value;
    const g = document.getElementById('website-color-g').value;
    const b = document.getElementById('website-color-b').value;

    const colorValue = `${r}, ${g}, ${b}`;
    document.documentElement.style.setProperty('--custom-color', colorValue);

    // Save color to localStorage
    localStorage.setItem('customColor', colorValue);
}

// Function to reset color to default
function resetColor() {
    document.getElementById('website-color-r').value = 0;
    document.getElementById('website-color-g').value = 255;
    document.getElementById('website-color-b').value = 192;

    applyColor(); // Reapply default color
    localStorage.removeItem('customColor'); // Clear from localStorage
}

// Function to apply border radius and save it in local storage
function applyBorderRadius() {
    const borderRadius = document.getElementById('website-border-radius').value + 'px';
    document.documentElement.style.setProperty('--custom-border-radius', borderRadius);

    // Save border radius to localStorage
    localStorage.setItem('customBorderRadius', borderRadius);
}

// Function to reset border radius to default
function resetBorderRadius() {
    document.getElementById('website-border-radius').value = 8;
    applyBorderRadius(); // Reapply default border radius
    localStorage.removeItem('customBorderRadius'); // Clear from localStorage
}

// Function to load saved values from localStorage on page load
function loadSettings() {
    const savedColor = localStorage.getItem('customColor');
    const savedBorderRadius = localStorage.getItem('customBorderRadius');

    if (savedColor) {
        const [r, g, b] = savedColor.split(', ');
        document.getElementById('website-color-r').value = r;
        document.getElementById('website-color-g').value = g;
        document.getElementById('website-color-b').value = b;
        document.documentElement.style.setProperty('--custom-color', savedColor);
    }

    if (savedBorderRadius) {
        document.getElementById('website-border-radius').value = parseInt(savedBorderRadius);
        document.documentElement.style.setProperty('--custom-border-radius', savedBorderRadius);
    }
}

// Ensure settings are loaded when the page reloads
window.onload = function() {
    loadSettings();
};

// Event listeners for buttons
document.getElementById('website-color-apply').addEventListener('click', () => {
    applyColor();
    loadSettings(); // Ensure values reflect in the page after applying
});

document.getElementById('website-color-reset').addEventListener('click', () => {
    resetColor();
    loadSettings(); // Reload default values after resetting
});

document.getElementById('website-border-radius-apply').addEventListener('click', () => {
    applyBorderRadius();
    loadSettings(); // Ensure values reflect in the page after applying
});

document.getElementById('website-border-radius-reset').addEventListener('click', () => {
    resetBorderRadius();
    loadSettings(); // Reload default values after resetting
});