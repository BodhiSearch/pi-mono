import { TooltipProvider } from '@/components/ui/tooltip';
import Header from './Header';
import ChatDemo from './chat/ChatDemo';

export default function Layout() {
  return (
    <TooltipProvider>
      <div className="fixed inset-0 flex flex-col">
        <Header />
        <ChatDemo />
      </div>
    </TooltipProvider>
  );
}
