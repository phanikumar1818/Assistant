document.addEventListener('DOMContentLoaded', () => {    
    // Get DOM elements
    const closeButton = document.getElementById('closeButton');
    const quitButton = document.getElementById('quitButton');
    const azureKeyInput = document.getElementById('azureKey');
    const azureRegionInput = document.getElementById('azureRegion');
    const geminiKeyInput = document.getElementById('geminiKey');
    const windowGapInput = document.getElementById('windowGap');
    const codingLanguageSelect = document.getElementById('codingLanguage');
    const activeSkillSelect = document.getElementById('activeSkill');
    const displaySelectionSelect = document.getElementById('displaySelection');
    const iconGrid = document.getElementById('iconGrid');
    const includeMicrophoneCheck = document.getElementById('includeMicrophone');
    const includeSystemAudioCheck = document.getElementById('includeSystemAudio');
    const btnClearChatHistory = document.getElementById('btnClearChatHistory');

    const fontSizeVal = document.getElementById('font-size-val');
    const btnFontDec = document.getElementById('btn-font-dec');
    const btnFontInc = document.getElementById('btn-font-inc');
    const btnFontReset = document.getElementById('btn-font-reset');

    const opacityVal = document.getElementById('opacity-val');
    const btnOpacityDec = document.getElementById('btn-opacity-dec');
    const btnOpacityInc = document.getElementById('btn-opacity-inc');
    const btnOpacityReset = document.getElementById('btn-opacity-reset');

    let currentFontSize = 13;
    let currentOpacity = 0.85;

    const btnSaveAzure = document.getElementById('btn-save-azure');
    const btnSaveRegion = document.getElementById('btn-save-region');
    const btnSaveGemini = document.getElementById('btn-save-gemini');

    // Check if window.api exists
    if (!window.api) {
        console.error('window.api not available');
        return;
    }

    // Request current settings when window opens
    const requestCurrentSettings = () => {
        if (window.electronAPI && window.electronAPI.getSettings) {
            window.electronAPI.getSettings().then(settings => {
                loadSettingsIntoUI(settings);
            }).catch(error => {
                console.error('Failed to get settings:', error);
            });
        }
    };

    // Close button handler
    if (closeButton) {
        closeButton.addEventListener('click', () => {
            window.api.send('close-settings');
        });
    }

    // Quit button handler with multiple attempts
    if (quitButton) {
        quitButton.addEventListener('click', () => {
            if (!confirm("Are you sure you want to quit Vysper Assistant?")) {
                return;
            }
            try {
                // Try multiple ways to quit the app
                if (window.api && window.api.send) {
                    window.api.send('quit-app');
                }
                
                // Also try the electron API if available
                if (window.electronAPI && window.electronAPI.quit) {
                    window.electronAPI.quit();
                }
                
                // Fallback: close the window
                setTimeout(() => {
                    window.close();
                }, 500);
                
            } catch (error) {
                console.error('Error quitting app:', error);
                window.close();
            }
        });
    }

    const populateDisplayOptions = (selectedVal) => {
        if (!displaySelectionSelect) return;
        
        if (window.electronAPI && window.electronAPI.getDisplays) {
            window.electronAPI.getDisplays().then(displays => {
                // Clear existing options
                displaySelectionSelect.innerHTML = '';
                
                // Add default options
                const openedOpt = document.createElement('option');
                openedOpt.value = 'opened';
                openedOpt.textContent = 'Stick to Screen Opened On';
                displaySelectionSelect.appendChild(openedOpt);
                
                const cursorOpt = document.createElement('option');
                cursorOpt.value = 'cursor';
                cursorOpt.textContent = 'Follow Mouse Cursor';
                displaySelectionSelect.appendChild(cursorOpt);
                
                // Add specific display options
                displays.forEach(display => {
                    const opt = document.createElement('option');
                    opt.value = display.id.toString();
                    opt.textContent = display.label;
                    displaySelectionSelect.appendChild(opt);
                });
                
                // Restore selection
                if (selectedVal) {
                    displaySelectionSelect.value = selectedVal;
                }
            }).catch(err => {
                console.error('Error fetching displays:', err);
            });
        }
    };

    // Function to load settings into UI
    const loadSettingsIntoUI = (settings) => {
        if (settings.azureKey && azureKeyInput) azureKeyInput.value = settings.azureKey;
        if (settings.azureRegion && azureRegionInput) azureRegionInput.value = settings.azureRegion;
        if (settings.geminiKey && geminiKeyInput) geminiKeyInput.value = settings.geminiKey;
        if (settings.windowGap && windowGapInput) windowGapInput.value = settings.windowGap;
        if (settings.codingLanguage && codingLanguageSelect) codingLanguageSelect.value = settings.codingLanguage;
        if (settings.activeSkill && activeSkillSelect) activeSkillSelect.value = settings.activeSkill;
        
        if (displaySelectionSelect) {
            populateDisplayOptions(settings.displaySelection || 'opened');
        }

        if (includeMicrophoneCheck) {
            includeMicrophoneCheck.checked = settings.includeMicrophone !== false;
        }
        if (includeSystemAudioCheck) {
            includeSystemAudioCheck.checked = settings.includeSystemAudio !== false;
        }

        if (settings.fontSize !== undefined) {
            currentFontSize = parseInt(settings.fontSize, 10) || 13;
        } else {
            currentFontSize = 13;
        }
        if (fontSizeVal) fontSizeVal.textContent = `${currentFontSize}px`;
        
        if (settings.bgOpacity !== undefined) {
            currentOpacity = parseFloat(settings.bgOpacity) || 0.85;
        } else {
            currentOpacity = 0.85;
        }
        if (opacityVal) opacityVal.textContent = `${Math.round(currentOpacity * 100)}%`;

        applyStylesLocally();

        // Handle icon selection
        const selectedIcon = settings.selectedIcon || settings.appIcon;
        if (selectedIcon && iconGrid) {
            const iconOptions = iconGrid.querySelectorAll('.icon-option');
            iconOptions.forEach(option => {
                if (option.dataset.icon === selectedIcon) {
                    option.classList.add('selected');
                } else {
                    option.classList.remove('selected');
                }
            });
        }
    };

    // Load settings when window opens
    window.api.receive('load-settings', (settings) => {
        loadSettingsIntoUI(settings);
    });

    // Listen for settings window shown event
    if (window.electronAPI && window.electronAPI.receive) {
        window.electronAPI.receive('settings-window-shown', () => {
            requestCurrentSettings();
        });
    }

    // Save settings helper function
    const saveSettings = () => {
        const settings = {};
        if (azureKeyInput) settings.azureKey = azureKeyInput.value;
        if (azureRegionInput) settings.azureRegion = azureRegionInput.value;
        if (geminiKeyInput) settings.geminiKey = geminiKeyInput.value;
        if (windowGapInput) settings.windowGap = windowGapInput.value;
        if (codingLanguageSelect) settings.codingLanguage = codingLanguageSelect.value;
        if (activeSkillSelect) settings.activeSkill = activeSkillSelect.value;
        if (displaySelectionSelect) settings.displaySelection = displaySelectionSelect.value;
        if (includeMicrophoneCheck) settings.includeMicrophone = includeMicrophoneCheck.checked;
        if (includeSystemAudioCheck) settings.includeSystemAudio = includeSystemAudioCheck.checked;
        
        settings.fontSize = currentFontSize;
        settings.bgOpacity = currentOpacity;
        
        window.api.send('save-settings', settings);
        applyStylesLocally();
    };

    const applyStylesLocally = () => {
        document.body.style.fontSize = `${currentFontSize}px`;
        const container = document.querySelector('.settings-container');
        if (container) {
            container.style.background = `rgba(20, 20, 20, ${currentOpacity})`;
        }
    };

    // Add event listeners for all inputs
    const inputs = [
        azureKeyInput,
        azureRegionInput,
        geminiKeyInput,
        windowGapInput
    ];

    inputs.forEach(input => {
        if (input) {
            input.addEventListener('change', saveSettings);
            input.addEventListener('blur', saveSettings);
        }
    });

    // Language selection handler
    if (codingLanguageSelect) {
        codingLanguageSelect.addEventListener('change', (e) => {
            saveSettings();
        });
    }

    // Display selection handler
    if (displaySelectionSelect) {
        displaySelectionSelect.addEventListener('change', (e) => {
            saveSettings();
        });
    }

    if (includeMicrophoneCheck) {
        includeMicrophoneCheck.addEventListener('change', () => {
            saveSettings();
        });
    }
    if (includeSystemAudioCheck) {
        includeSystemAudioCheck.addEventListener('change', () => {
            saveSettings();
        });
    }

    if (btnClearChatHistory) {
        btnClearChatHistory.addEventListener('click', async () => {
            if (confirm('Are you sure you want to clear the active chat history and memory?')) {
                if (window.electronAPI && window.electronAPI.clearSessionMemory) {
                    await window.electronAPI.clearSessionMemory();
                }
                alert('Session memory cleared successfully!');
            }
        });
    }

    // Skill selection handler
    if (activeSkillSelect) {
        activeSkillSelect.addEventListener('change', (e) => {
            saveSettings();
            // Also update the main window
            window.api.send('update-skill', e.target.value);
        });
    }

    if (btnFontDec) {
        btnFontDec.addEventListener('click', () => {
            if (currentFontSize > 10) {
                currentFontSize--;
                fontSizeVal.textContent = `${currentFontSize}px`;
                saveSettings();
            }
        });
    }
    if (btnFontInc) {
        btnFontInc.addEventListener('click', () => {
            if (currentFontSize < 20) {
                currentFontSize++;
                fontSizeVal.textContent = `${currentFontSize}px`;
                saveSettings();
            }
        });
    }
    if (btnFontReset) {
        btnFontReset.addEventListener('click', () => {
            currentFontSize = 13;
            fontSizeVal.textContent = `${currentFontSize}px`;
            saveSettings();
        });
    }

    if (btnOpacityDec) {
        btnOpacityDec.addEventListener('click', () => {
            if (currentOpacity > 0.30) {
                currentOpacity = parseFloat((currentOpacity - 0.05).toFixed(2));
                opacityVal.textContent = `${Math.round(currentOpacity * 100)}%`;
                saveSettings();
            }
        });
    }
    if (btnOpacityInc) {
        btnOpacityInc.addEventListener('click', () => {
            if (currentOpacity < 1.00) {
                currentOpacity = parseFloat((currentOpacity + 0.05).toFixed(2));
                opacityVal.textContent = `${Math.round(currentOpacity * 100)}%`;
                saveSettings();
            }
        });
    }
    if (btnOpacityReset) {
        btnOpacityReset.addEventListener('click', () => {
            currentOpacity = 0.85;
            opacityVal.textContent = `${Math.round(currentOpacity * 100)}%`;
            saveSettings();
        });
    }

    const triggerSaveFeedback = (btn) => {
        const originalBg = btn.style.background;
        const originalColor = btn.style.color;
        btn.style.background = '#2e7d32'; // Green success color
        btn.style.color = '#fff';
        btn.innerHTML = '<i class="fas fa-check-double"></i>';
        setTimeout(() => {
            btn.style.background = originalBg;
            btn.style.color = originalColor;
            btn.innerHTML = '<i class="fas fa-check"></i>';
        }, 1000);
    };

    if (btnSaveAzure) {
        btnSaveAzure.addEventListener('click', () => {
            saveSettings();
            triggerSaveFeedback(btnSaveAzure);
        });
    }
    if (btnSaveRegion) {
        btnSaveRegion.addEventListener('click', () => {
            saveSettings();
            triggerSaveFeedback(btnSaveRegion);
        });
    }
    if (btnSaveGemini) {
        btnSaveGemini.addEventListener('click', () => {
            saveSettings();
            triggerSaveFeedback(btnSaveGemini);
        });
    }

    // Initialize icon grid with correct paths
    const initializeIconGrid = () => {
        if (!iconGrid) return;

        const icons = [
            { key: 'terminal', name: 'Terminal', src: './assests/icons/terminal.png' },
            { key: 'activity', name: 'Activity', src: './assests/icons/activity.png' },
            { key: 'settings', name: 'Settings', src: './assests/icons/settings.png' }
        ];

        iconGrid.innerHTML = '';

        icons.forEach(icon => {
            const iconElement = document.createElement('div');
            iconElement.className = 'icon-option';
            iconElement.dataset.icon = icon.key;
            
            const img = document.createElement('img');
            img.src = icon.src;
            img.alt = icon.name;
            img.onload = () => {
                logger.info('Icon loaded successfully:', icon.src);
            };
            img.onerror = () => {
                console.error('Failed to load icon:', icon.src);
                // Try alternative paths
                const altPaths = [
                    `./assests/${icon.key}.png`,
                    `./assets/icons/${icon.key}.png`,
                    `./assets/${icon.key}.png`
                ];
                
                let pathIndex = 0;
                const tryNextPath = () => {
                    if (pathIndex < altPaths.length) {
                        img.src = altPaths[pathIndex];
                        pathIndex++;
                    } else {
                        img.style.display = 'none';
                        console.error('All icon paths failed for:', icon.key);
                    }
                };
                
                img.onload = () => {
                    logger.info('Icon loaded with alternative path:', img.src);
                };
                
                img.onerror = tryNextPath;
                tryNextPath();
            };
            
            const label = document.createElement('div');
            label.textContent = icon.name;
            
            iconElement.appendChild(img);
            iconElement.appendChild(label);
            
            // Click handler for icon selection
            iconElement.addEventListener('click', () => {                
                // Remove selection from all icons
                iconGrid.querySelectorAll('.icon-option').forEach(opt => {
                    opt.classList.remove('selected');
                });
                
                // Add selection to clicked icon
                iconElement.classList.add('selected');
                
                // Save the selection - this should trigger the app icon change
                window.api.send('save-settings', { selectedIcon: icon.key });
                
                // Show visual feedback
                iconElement.style.transform = 'scale(0.95)';
                setTimeout(() => {
                    iconElement.style.transform = 'scale(1)';
                }, 100);
            });
            
            iconGrid.appendChild(iconElement);
        });
    };

    // Initialize icon grid
    initializeIconGrid();

    // Request settings on load
    setTimeout(() => {
        requestCurrentSettings();
    }, 200);

    // ESC key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.api.send('close-settings');
        }
    });
}); 