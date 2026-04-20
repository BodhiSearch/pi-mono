import { useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { VaultProvider } from '@/providers/VaultProvider';
import Header from './Header';
import ChatDemo from './chat/ChatDemo';
import VaultPanel from './vault/VaultPanel';
import FileViewer from './vault/FileViewer';

export default function Layout() {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <TooltipProvider>
      <VaultProvider>
        <div className="fixed inset-0 flex flex-col">
          <Header />
          <div className="flex-1 flex overflow-hidden">
            <VaultPanel selected={selected} onSelect={setSelected} />
            <main className="flex-1 flex min-w-0 overflow-hidden border-r">
              <FileViewer selected={selected} />
            </main>
            <div className="w-[420px] shrink-0 flex flex-col overflow-hidden">
              <ChatDemo />
            </div>
          </div>
        </div>
      </VaultProvider>
    </TooltipProvider>
  );
}
