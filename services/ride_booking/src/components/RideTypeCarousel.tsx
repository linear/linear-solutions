import React, { useId } from "react";
import type { RideTypeCarouselProps } from "../types.js";
import { RideTypeCard } from "./RideTypeCard.js";

/**
 * RideTypeCarousel renders a horizontal list of ride type options.
 *
 * Accessibility:
 * - role="radiogroup" groups the mutually-exclusive radio cards.
 * - aria-labelledby links the group to its visible heading so screen readers
 *   announce context before reading individual cards.
 * - Keyboard navigation: arrow keys move focus between cards; Enter/Space
 *   selects the focused card (handled inside RideTypeCard).
 */
export function RideTypeCarousel({
  rideTypes,
  selectedId,
  onSelect,
  label = "Choose a ride type",
}: RideTypeCarouselProps) {
  const headingId = useId();

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const cards = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'),
    );
    const focused = document.activeElement as HTMLElement;
    const currentIndex = cards.indexOf(focused);

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      const next = cards[(currentIndex + 1) % cards.length];
      next?.focus();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      const prev = cards[(currentIndex - 1 + cards.length) % cards.length];
      prev?.focus();
    }
  }

  return (
    <section aria-labelledby={headingId} className="ride-type-carousel">
      <h2 id={headingId} className="ride-type-carousel__heading">
        {label}
      </h2>
      <div
        role="radiogroup"
        aria-labelledby={headingId}
        onKeyDown={handleKeyDown}
        className="ride-type-carousel__list"
      >
        {rideTypes.map((rideType) => (
          <RideTypeCard
            key={rideType.id}
            rideType={rideType}
            isSelected={rideType.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
}
