
import type { Agent } from "../types";

interface AgentSwitcherProps {
  agents: Agent[];
  selectedAgent: string | null;
  onAgentChange: (agentName: string) => void;
}

export function AgentSwitcher(props: AgentSwitcherProps) {
  const currentAgent = () => {
    const name = props.selectedAgent;
    return props.agents.find(a => a.name === name);
  };
  
  const cycleAgent = () => {
    const agentList = props.agents;
    if (agentList.length === 0) return;
    
    const currentIndex = agentList.findIndex(a => a.name === props.selectedAgent);
    const nextIndex = (currentIndex + 1) % agentList.length;
    props.onAgentChange(agentList[nextIndex].name);
  };
  
  const agentColor = () => currentAgent()?.options?.color;
  
  return (
    <button
      type="button"
      class="agent-switcher-button"
      onClick={cycleAgent}
      aria-label="Switch agent"
      title={currentAgent()?.description || 'Switch agent'}
      style={agentColor() ? { color: agentColor() } : {}}
    >
      {currentAgent()?.name || 'Agent'}
    </button>
  );
}
