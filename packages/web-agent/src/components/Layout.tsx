import { TooltipProvider } from '@/components/ui/tooltip';
import Header from './Header';
import ChatDemo from './chat/ChatDemo';
import VaultPanel from './vault/VaultPanel';

export default function Layout() {
  return (
    <TooltipProvider>
      <div className="fixed inset-0 flex flex-col">
        <Header />
        <div className="flex-1 flex overflow-hidden">
          <VaultPanel />
          <div className="flex-1 flex flex-col overflow-hidden">
            <ChatDemo />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
