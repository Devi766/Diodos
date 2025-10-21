# FlyClash UI - Surge 6 Redesign

## Overview

This document describes the complete UI redesign of FlyClash inspired by Surge 6 for macOS. The redesign features Gaussian blur effects with real-time backdrop blur, modern glassmorphism aesthetics, and a clean, professional interface.

## Design Philosophy

The new design follows Surge 6's design principles:
- **Glassmorphism**: Translucent panels with backdrop blur effects
- **Clean Metrics**: Large, readable numbers with consistent spacing
- **Subtle Animations**: Smooth transitions and hover effects
- **Modern Color Scheme**: Professional blue accent with refined grays
- **Real-time Blur**: Live backdrop blur that updates with content behind it

## Key Changes

### 1. Theme System (global.css)

#### Light Mode
- **Background**: Subtle gradient from white to light gray (`240 20% 98%` to `220 14% 96%`)
- **Primary Color**: Professional blue (`214 100% 50%`)
- **Glass Background**: `rgba(255, 255, 255, 0.72)` with 40px blur
- **Sidebar Background**: `rgba(255, 255, 255, 0.78)` with enhanced blur
- **Card Background**: `rgba(255, 255, 255, 0.65)` with blur saturation

#### Dark Mode
- **Background**: Deep dark blue-gray (`222 47% 11%`)
- **Primary Color**: Brighter blue (`214 100% 60%`)
- **Glass Background**: `rgba(26, 27, 30, 0.75)` with 40px blur
- **Sidebar Background**: `rgba(22, 23, 26, 0.82)` with enhanced blur
- **Card Background**: `rgba(30, 31, 34, 0.68)` with blur saturation

#### Blur Effects
```css
--blur-strength: 40px;
--blur-saturation: 180%;
backdrop-filter: blur(var(--blur-strength)) saturate(var(--blur-saturation));
-webkit-backdrop-filter: blur(var(--blur-strength)) saturate(var(--blur-saturation));
```

### 2. Layout Component Updates

#### Sidebar
- **Width**: Collapsed: 80px → Expanded: 260px (reduced from 92px/296px)
- **Border Radius**: 20px for modern rounded corners
- **Navigation Items**:
  - Rounded corners reduced to `rounded-xl` (12px)
  - Active state uses primary color with shadow
  - Hover states with subtle accent background
  - Icon size: 8x8 (20px) for cleaner look

#### Status Indicator
- **Green Pulsing Dot**: Gradient with soft shadow and animation
- **Metric Card Style**: Applied to status section
- **Typography**: Reduced sizes for cleaner appearance

### 3. New Dashboard Component (DashboardNew.tsx)

#### Header Section
- Title: "Activity" with description
- Status badges for System Proxy and Enhanced Mode
- Live indicator dots

#### Metric Cards
The new design features six main card types:

1. **Network Info Cards** (4 cards in a row)
   - Network/Profile name
   - Active profile (macOS)
   - Outbound mode (Rule-Based Proxy)
   - External IP address

2. **Latency Card**
   - Large latency display (e.g., "9 ms")
   - Diagnostics button
   - Breakdown: Router, DNS, Proxy latency

3. **Speed Card**
   - Upload speed with icon
   - Download speed with icon
   - Peak speed indicators
   - Real-time metrics

4. **Active Connections Card**
   - Large connection count (e.g., "73")
   - Live pulse indicator
   - Breakdown: Processes, Devices, DHCP Devices

5. **Total Traffic Card**
   - Today/Month toggle
   - Total traffic display
   - Direct vs Proxy breakdown with colored indicators

6. **Traffic by Client Card**
   - Tab switcher: Client / Domain / Policy
   - List of top applications with icons
   - Traffic per application

#### Card Styling
```css
.metric-card {
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(20px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 16px;
  padding: 20px;
  box-shadow: 0 4px 16px rgba(31, 38, 135, 0.06);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.metric-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(31, 38, 135, 0.12);
}
```

### 4. Component Classes

#### Glass Panel
```css
.glass-panel {
  background: var(--glass-bg-light);
  backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 8px 32px rgba(31, 38, 135, 0.08);
}
```

#### Glass Sidebar
```css
.glass-sidebar {
  background: var(--sidebar-bg-light);
  backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 20px;
  box-shadow: 0 8px 32px rgba(31, 38, 135, 0.1);
}
```

#### Status Indicator
```css
.indicator-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: linear-gradient(135deg, #10b981 0%, #059669 100%);
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.2),
              0 0 8px rgba(16, 185, 129, 0.3);
  animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
}
```

## File Changes

### Modified Files
1. **flycast-ui/src/global.css**
   - New color scheme with HSL variables
   - Blur effect variables and classes
   - Metric card styles
   - Status indicator animations
   - Glassmorphism components

2. **flycast-ui/src/components/Layout.tsx**
   - Updated sidebar width and spacing
   - Simplified navigation styling
   - Applied metric-card to status section
   - Reduced border radius for modern look
   - Updated hover and active states

3. **flycast-ui/app/page.tsx**
   - Changed from Dashboard to DashboardNew component

### New Files
1. **flycast-ui/src/components/DashboardNew.tsx**
   - Complete Surge 6-inspired dashboard
   - Six metric card sections
   - Real-time data display
   - Responsive grid layout

## Typography

### Size Scale
- **Title (h1)**: 2xl (24px) - Section headers
- **Metric Values**: 4xl-5xl (36px-48px) - Primary numbers
- **Labels**: xs (12px) - Uppercase labels with tracking
- **Body**: sm (14px) - Standard text
- **Secondary**: xs (10px-11px) - Chips and badges

### Font Weights
- **Bold**: 700 - Metric values
- **Semibold**: 600 - Section titles
- **Medium**: 500 - Labels and chips
- **Regular**: 400 - Body text

## Color Palette

### Light Mode
- **Primary**: Blue `#007AFF` (214 100% 50%)
- **Foreground**: Dark gray `#2D3748` (220 13% 18%)
- **Muted**: Light gray `#A0AEC0` (220 9% 46%)
- **Accent**: Very light blue `#EBF4FF` (214 95% 95%)
- **Border**: Light gray `#E2E8F0` (220 13% 91%)

### Dark Mode
- **Primary**: Bright blue `#3B82F6` (214 100% 60%)
- **Foreground**: Light gray `#E5E7EB` (220 13% 91%)
- **Muted**: Medium gray `#9CA3AF` (220 9% 60%)
- **Accent**: Dark blue `#1E3A5F` (214 50% 25%)
- **Border**: Dark gray `#374151` (220 13% 25%)

## Spacing System

- **Card Padding**: 20px
- **Card Gap**: 16px (gap-4)
- **Section Gap**: 20px (gap-5)
- **Icon Size**: 16px (w-4 h-4)
- **Badge Padding**: 4px 10px

## Border Radius

- **Cards**: 16px (rounded-2xl)
- **Sidebar**: 20px
- **Buttons**: 8-12px (rounded-lg / rounded-xl)
- **Status Indicator**: 50% (fully round)

## Testing

### Development Server
```bash
cd flycast-ui
npm run dev
```

Visit: http://localhost:3001

### Testing Checklist
- [ ] Light mode blur effects working
- [ ] Dark mode blur effects working
- [ ] Sidebar collapse/expand animation smooth
- [ ] Metric cards hovering properly
- [ ] Status indicator pulsing
- [ ] Responsive layout on mobile
- [ ] All icons displaying correctly
- [ ] Typography hierarchy clear

## Browser Compatibility

The blur effects work best in:
- **Chrome/Edge**: Full support with `-webkit-backdrop-filter`
- **Safari**: Full support with `-webkit-backdrop-filter`
- **Firefox**: Limited support (may need to enable in about:config)

For Firefox, blur effects may not work perfectly. Consider adding a fallback:
```css
@supports not (backdrop-filter: blur(40px)) {
  .glass-panel {
    background: rgba(255, 255, 255, 0.95);
  }
}
```

## Performance Considerations

1. **Blur Performance**: 40px blur is GPU-accelerated but may impact older devices
2. **Re-renders**: Metric values use `font-variant-numeric: tabular-nums` to prevent layout shifts
3. **Animations**: All transitions use `transform` and `opacity` for 60fps performance

## Future Enhancements

1. **Real-time Traffic Chart**: SVG-based chart with smooth animations
2. **Live Connection Table**: Similar to Surge 6's connection view
3. **Node Selection UI**: Grid-based node selector
4. **Dark Mode Toggle**: Smooth transition between modes
5. **Themes**: Additional color schemes (Purple, Green, Orange)

## Reverting Changes

To revert to the original design:

1. Restore `global.css` from git history
2. Restore `Layout.tsx` from git history
3. Change `app/page.tsx` back to use `Dashboard` instead of `DashboardNew`

```bash
git checkout HEAD -- src/global.css
git checkout HEAD -- src/components/Layout.tsx
# Edit app/page.tsx manually to use Dashboard
```

## Credits

Design inspired by:
- **Surge 6 for macOS** by Yachen Liu
- **iOS 15+ Design Language** by Apple
- **Glassmorphism UI Trend** (2020-2024)

## License

This redesign follows the same license as the FlyClash project.
