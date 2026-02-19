import type { LucideProps } from 'lucide-react';
import {
	AlertCircle,
	AtSign,
	Book,
	Bot,
	Check,
	CheckCircle,
	ChevronDown,
	ChevronRight,
	Clock,
	Coins,
	Copy,
	Download,
	Edit3,
	ExternalLink,
	File,
	FileText,
	FolderOpen,
	Globe,
	Hash,
	HelpCircle,
	Image,
	List,
	Loader2,
	MessageSquare,
	Microchip,
	Pause,
	Play,
	Plug,
	Plus,
	RefreshCw,
	Search,
	Server,
	Settings,
	Shield,
	Sparkles,
	Square,
	Tag,
	Terminal,
	Timer,
	Trash2,
	Undo2,
	Wand2,
	X,
	Zap,
} from 'lucide-react';
import React from 'react';

// Helper: memoize a lucide icon to prevent re-renders with identical props
const memoIcon = (Icon: React.FC<LucideProps>) => React.memo(Icon);

// Hot-path icons that appear in frequently re-rendering parents
export const CloseIcon = memoIcon(X);
export const MessageIcon = memoIcon(MessageSquare);
export const PlusIcon = memoIcon(Plus);
export const SettingsIcon = memoIcon(Settings);
export const HistoryIcon = memoIcon(Clock);
export const TimerIcon = memoIcon(Timer);
export const LoaderIcon = memoIcon(Loader2);
export const SparklesIcon = memoIcon(Sparkles);
export const TerminalIcon = memoIcon(Terminal);
export const AtSignIcon = memoIcon(AtSign);
export const ImageIcon = memoIcon(Image);
export const BotIcon = memoIcon(Bot);
export const ChevronDownIcon = memoIcon(ChevronDown);

// Remaining icons — direct re-exports (less hot paths)
export {
	AlertCircle as AlertCircleIcon,
	Book as BookIcon,
	Check as CheckIcon,
	CheckCircle as CheckCircleIcon,
	ChevronRight as ChevronRightIcon,
	Clock as ClockIcon,
	Coins as TokensIcon,
	Copy as CopyIcon,
	Download as DownloadIcon,
	Edit3 as EditIcon,
	Edit3 as PencilIcon,
	ExternalLink as ExternalLinkIcon,
	File as FileIcon,
	FileText as FileTextIcon,
	FolderOpen as FolderOpenIcon,
	Globe as GlobeIcon,
	Hash as HashIcon,
	HelpCircle as HelpCircleIcon,
	List as ListIcon,
	Microchip as McpIcon,
	Pause as PauseIcon,
	Play as PlayIcon,
	Plug as PlugIcon,
	RefreshCw as RefreshIcon,
	Search as SearchIcon,
	Server as ServerIcon,
	Shield as ShieldIcon,
	Square as StopIcon,
	Tag as TagIcon,
	Trash2 as TrashIcon,
	Undo2 as Undo2Icon,
	Wand2 as WandIcon,
	Zap as ZapIcon,
};
// Custom SVG icons
export {
	AcceptIcon,
	AgentsIcon,
	BrainSideIcon,
	ChevronIcon,
	ImprovePromptIcon,
	PlanIcon,
	RejectIcon,
	SmallCloseIcon,
	TodoCheckIcon,
	TodoListIcon,
	TodoPendingIcon,
	TodoProgressIcon,
} from './CustomIcons';
export { FileTypeIcon } from './FileTypeIcon';
