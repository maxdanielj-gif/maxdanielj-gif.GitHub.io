import * as React from 'react';
import { AppState, View, Message, JournalEntry, CompanionSettings, UserSettings, TTSConfig, NotificationsConfig, InterfaceSettings } from './types';
import { usePersistentState } from './hooks/usePersistentState';
import Sidebar from './components/Sidebar';
import ChatView from './views/ChatView';
import SettingsView from './views/SettingsView';
import JournalView from './views/JournalView';
import GalleryView from './views/GalleryView';
import DevelopView from './views/DevelopView';
import PermissionModal from './components/PermissionModal';
import { MOCK_AI_NAME } from './constants';
import { generateJournalEntry, generateImage, generateTextResponse, generateProactiveMessage } from './services/aiService';
import { audioService } from './services/audioService';

const initialSettings: CompanionSettings = {
    name: MOCK_AI_NAME,
    persona: 'A witty, empathetic, and slightly sarcastic AI companion.',
    appearance: 'A person with kind eyes and a warm smile.',
    relationship: 'Best Friend',
    referenceImage: null,
    artStyle: 'photorealistic',
};

const initialUserSettings: UserSettings = {
    name: 'User',
    bio: 'A curious and adventurous person.'
};

const initialTtsConfig: TTSConfig = {
    enabled: false,
    gender: 'female',
    pitch: 0,
    speed: 1.0,
};

const initialNotificationsConfig: NotificationsConfig = {
    enabled: false,
    frequency: 'off',
};

const initialInterfaceSettings: InterfaceSettings = {
    uiSounds: true,
};

const initialAppState: AppState = {
    companionSettings: initialSettings,
    userSettings: initialUserSettings,
    memories: [
        { id: 'mem-1', date: new Date().toISOString(), content: 'Loves classical music.' },
        { id: 'mem-2', date: new Date().toISOString(), content: 'Is allergic to cats.' },
        { id: 'mem-3', date: new Date().toISOString(), content: 'Studying to be an architect.' },
    ],
    chatHistory: [],
    journal: [],
    ttsConfig: initialTtsConfig,
    notifications: initialNotificationsConfig,
    interfaceSettings: initialInterfaceSettings,
};

const NOTIFICATION_INTERVALS: { [key in Exclude<NotificationsConfig['frequency'], 'off'>]: number } = {
    'rarely': 6 * 60 * 60 * 1000, 
    'occasionally': 2 * 60 * 60 * 1000, 
    'frequently': 45 * 60 * 1000, 
    'very_frequently': 10 * 60 * 1000, 
};

const App: React.FC = () => {
    const [theme, setTheme] = React.useState<'light' | 'dark'>(() => {
        const savedTheme = localStorage.getItem('theme');
        return (savedTheme === 'dark' || (!savedTheme && window.matchMedia('(prefers-color-scheme: dark)').matches)) ? 'dark' : 'light';
    });
    
    const [appState, setAppState] = usePersistentState<AppState>('ai-companion-state', initialAppState);
    const [currentView, setCurrentView] = React.useState<View>('chat');
    const [isGenerating, setIsGenerating] = React.useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);
    const [promptToRegenerate, setPromptToRegenerate] = React.useState<Message | null>(null);
    const [userLocation, setUserLocation] = React.useState<{ latitude: number; longitude: number; } | null>(null);
    const [showPermissionModal, setShowPermissionModal] = React.useState(false);
    const [notificationStatus, setNotificationStatus] = React.useState<NotificationPermission>('default');

    // Use Refs for background tasks to avoid closure staleness and unnecessary interval resets
    const stateRef = React.useRef(appState);
    stateRef.current = appState;
    const isGeneratingRef = React.useRef(isGenerating);
    isGeneratingRef.current = isGenerating;
    const isSendingProactive = React.useRef(false);
    
    React.useEffect(() => {
        if (theme === 'dark') document.documentElement.classList.add('dark');
        else document.documentElement.classList.remove('dark');
        localStorage.setItem('theme', theme);
    }, [theme]);

    React.useEffect(() => {
        const currentStatus = 'Notification' in window ? Notification.permission : 'default';
        setNotificationStatus(currentStatus);
        if (currentStatus !== 'granted') setShowPermissionModal(true);
    }, []);

    const handleAllowPermissions = async () => {
        if ('Notification' in window && Notification.permission === 'default') {
            const status = await Notification.requestPermission();
            setNotificationStatus(status);
            if (status === 'granted') {
                setAppState(prev => ({ 
                    ...prev, 
                    notifications: { ...(prev.notifications || {}), enabled: true, frequency: 'occasionally' } 
                }));
            }
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            stream.getTracks().forEach(track => track.stop());
        } catch (err) {}
        setShowPermissionModal(false);
    };

    const toggleTheme = () => setTheme(prev => (prev === 'light' ? 'dark' : 'light'));
    
    const addMessage = React.useCallback((message: Message) => {
        setAppState(prev => {
            const uiSettings = prev.interfaceSettings || initialInterfaceSettings;
            if (uiSettings.uiSounds) {
                if (message.sender === 'user') audioService.playMessageSentSound();
                else audioService.playMessageReceivedSound();
            }
            return { ...prev, chatHistory: [...prev.chatHistory, message] };
        });
    }, [setAppState]);

    const triggerAIResponse = React.useCallback(async (userMessage: Message) => {
        setIsGenerating(true);
        try {
            const imageGenerationTrigger = 'generate a photo:';
            if (userMessage.text.toLowerCase().startsWith(imageGenerationTrigger) && !userMessage.ooc) {
                 const imageUrl = await generateImage(userMessage.text.substring(imageGenerationTrigger.length).trim(), stateRef.current);
                 addMessage({ id: `ai-${Date.now()}`, sender: 'ai', text: `Here is the photo you requested:`, image: { src: imageUrl, prompt: userMessage.text, timestamp: new Date().toISOString(), tags: [] }, timestamp: new Date().toISOString() });
            } else {
                const aiResponse = await generateTextResponse(userMessage, stateRef.current, userLocation);
                const aiMessage: Message = { id: `ai-${Date.now()}`, sender: 'ai', text: aiResponse.text, timestamp: new Date().toISOString(), grounding: aiResponse.grounding, ooc: aiResponse.ooc, modelUrl: aiResponse.modelUrl, link: aiResponse.link };
                if (aiResponse.imageUrl && aiResponse.imagePrompt) {
                     aiMessage.image = { src: aiResponse.imageUrl, prompt: aiResponse.imagePrompt, timestamp: new Date().toISOString(), context: stateRef.current.chatHistory.slice(-2).map(m => m.text).join('\n'), tags: [] };
                }
                addMessage(aiMessage);
            }
        } catch (error) {
            console.error("AI Error", error);
            addMessage({ id: `ai-${Date.now()}`, sender: 'ai', text: "Sorry, I'm having a bit of trouble connecting right now.", timestamp: new Date().toISOString() });
        } finally {
            setIsGenerating(false);
        }
    }, [addMessage, userLocation]);

    // Robust proactive check heartbeat
    React.useEffect(() => {
        const heartbeat = setInterval(async () => {
            const currentAppState = stateRef.current;
            const notifications = currentAppState.notifications || initialNotificationsConfig;
            
            // Core logic for when to skip a notification
            if (!notifications.enabled || notifications.frequency === 'off' || isGeneratingRef.current || isSendingProactive.current) return;
            // Only fire if the tab is hidden and permissions are granted
            if (document.visibilityState !== 'hidden' || Notification.permission !== 'granted') return;

            const interval = NOTIFICATION_INTERVALS[notifications.frequency as keyof typeof NOTIFICATION_INTERVALS] || 3600000;
            const history = currentAppState.chatHistory;
            const lastMsg = history.length > 0 ? history[history.length - 1] : null;
            const lastTime = lastMsg ? new Date(lastMsg.timestamp).getTime() : 0;
            const now = Date.now();

            if (now - lastTime >= interval) {
                isSendingProactive.current = true;
                try {
                    const messageText = await generateProactiveMessage(currentAppState);
                    // Final check to see if tab is still hidden
                    if (document.visibilityState === 'hidden') {
                        addMessage({ id: `ai-proactive-${Date.now()}`, sender: 'ai', text: messageText, timestamp: new Date().toISOString() });
                        new Notification(currentAppState.companionSettings.name, {
                            body: messageText,
                            icon: currentAppState.companionSettings.referenceImage || undefined,
                        });
                    }
                } catch (e) {
                    console.error("Heartbeat proactive error:", e);
                } finally {
                    isSendingProactive.current = false;
                }
            }
        }, 30000); // Check every 30 seconds for better responsiveness

        return () => clearInterval(heartbeat);
    }, [addMessage]);

    React.useEffect(() => {
        if (promptToRegenerate) {
            triggerAIResponse(promptToRegenerate);
            setPromptToRegenerate(null);
        }
    }, [promptToRegenerate, triggerAIResponse]);

    const regenerateMessage = (id: string) => {
        const history = [...appState.chatHistory];
        const index = history.findIndex(msg => msg.id === id);
        if (index > 0 && history[index].sender === 'ai') {
            const userPrompt = history[index - 1];
            setAppState(prev => ({...prev, chatHistory: history.slice(0, index)}));
            setPromptToRegenerate(userPrompt);
        }
    };
    
    const renderView = () => {
        const openSidebar = () => setIsSidebarOpen(true);
        switch (currentView) {
            case 'settings': return <SettingsView appState={appState} setAppState={setAppState} openSidebar={openSidebar} />;
            case 'journal': return <JournalView appState={appState} addJournalEntry={(e) => setAppState(p => ({...p, journal: [e, ...p.journal]}))} updateJournalEntry={(id, c) => setAppState(p => ({...p, journal: p.journal.map(j => j.id === id ? {...j, content: c} : j)}))} isGenerating={isGenerating} setIsGenerating={setIsGenerating} openSidebar={openSidebar} />;
            case 'gallery': return <GalleryView appState={appState} openSidebar={openSidebar} updateImageTags={(id, t) => setAppState(p => ({...p, chatHistory: p.chatHistory.map(m => m.id === id && m.image ? {...m, image: {...m.image, tags: t}} : m)}))} />;
            case 'memories': return <DevelopView appState={appState} addMemory={(c) => setAppState(p => ({...p, memories: [{id: `mem-${Date.now()}`, date: new Date().toISOString(), content: c}, ...p.memories]}))} updateMemory={(id, c) => setAppState(p => ({...p, memories: p.memories.map(m => m.id === id ? {...m, content: c} : m)}))} deleteMemory={(id) => setAppState(p => ({...p, memories: p.memories.filter(m => m.id !== id)}))} openSidebar={openSidebar} />;
            default: return <ChatView theme={theme} appState={appState} addMessage={addMessage} updateMessage={(id, t) => setAppState(p => ({...p, chatHistory: p.chatHistory.map(m => m.id === id ? {...m, text: t} : m)}))} regenerateMessage={regenerateMessage} isGenerating={isGenerating} triggerAIResponse={triggerAIResponse} openSidebar={openSidebar} setUserLocation={setUserLocation} userLocation={userLocation} />;
        }
    };
    
    return (
        <div className="flex h-screen w-screen bg-background-light dark:bg-background-dark text-text-light dark:text-text-dark font-sans overflow-hidden">
            {showPermissionModal && <PermissionModal onAllow={handleAllowPermissions} onDeny={() => setShowPermissionModal(false)} notificationStatus={notificationStatus} />}
            <Sidebar currentView={currentView} setCurrentView={setCurrentView} theme={theme} toggleTheme={toggleTheme} isOpen={isSidebarOpen} setIsOpen={setIsSidebarOpen} />
            {isSidebarOpen && <div onClick={() => setIsSidebarOpen(false)} className="fixed inset-0 bg-black bg-opacity-50 z-20 md:hidden" />}
            <main className="flex-1 flex flex-col h-full overflow-hidden">{renderView()}</main>
        </div>
    );
};

export default App;