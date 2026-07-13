'use client';

import { PageHeader } from '@/components/ui/PageHeader';
import { DomainFeatureSections } from '@/components/hub/DomainFeatureSections';

export default function PlanningHubPage() {
    return (
        <div className="space-y-6">
            <PageHeader
                title="Planning"
                subtitle="Look forward — near-term cash, long-term independence, and keeping it all safe."
            />
            <DomainFeatureSections domain="planning" />
        </div>
    );
}
