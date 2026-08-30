# Dashboard Empty States Redesign

## Goal
Transform the plain text empty states on the Dashboard charts ("Messages Sent vs Delivered" and "Delivery Rate Trend") into professional, engaging, and action-oriented components that guide new users to value.

## Selected Approach: The "Actionable Skeleton" (Hybrid)
We will combine the anticipation of a Skeleton layout (Option C) with the action-driven CTA of Option A. 
This provides visual structure to the page even when there is no data, while clearly instructing the user on what to do next.

## Components

### 1. Messages Sent vs Delivered (Bar Chart)
- **Background:** A blurred, low-opacity SVG or CSS representation of a Bar Chart (#3B82F6 and #22C55E).
- **Overlay:** A centered glassmorphism card.
- **Icon:** A "Send" (Paper plane) or "Message" icon.
- **Copy:** "Your messaging journey starts here. Send your first campaign to see delivery metrics."
- **Action:** A primary Button linking to /events or /campaigns (Create Campaign).

### 2. Delivery Rate Trend (Line Chart)
- **Background:** A blurred, low-opacity SVG representation of a Line Chart with a rising trend.
- **Overlay:** A centered glassmorphism card.
- **Icon:** A "Trending Up" (📈) or "Activity" icon.
- **Copy:** "Track your success. Trend data will populate once your campaigns go live."

## Technical Implementation
- Update rontend/src/pages/Dashboard.tsx
- Replace the ( <div className='h-full flex items-center justify-center...> blocks with the new custom Empty State components.
- Use Tailwind CSS ackdrop-blur-sm, opacity-10, and bsolute inset-0 to create the blurred skeleton effect.
- Use lucide-react for the icons.
- Add eact-router-dom <Link> for the CTA button to direct the user to the actionable page (e.g. /events).

## Edge Cases
- Ensure the overlay text is readable against the skeleton background (use adequate contrast / background-color on the overlay container).
- Ensure the layout is responsive and scales down properly on mobile devices.
