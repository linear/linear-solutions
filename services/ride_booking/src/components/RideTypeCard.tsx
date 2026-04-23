import React from "react";
import type { RideTypeCardProps } from "../types.js";

/**
 * RideTypeCard renders a single ride option in the booking carousel.
 *
 * Accessibility:
 * - Uses role="radio" to communicate that cards form a mutually-exclusive
 *   selection group (the carousel acts as the radiogroup container).
 * - aria-checked reflects the current selection state.
 * - aria-label provides a complete, plain-language description read by
 *   screen readers, including ride name, ETA, and price.
 */
export function RideTypeCard({ rideType, isSelected, onSelect }: RideTypeCardProps) {
  const { id, name, description, estimatedMinutes, estimatedPrice, currencySymbol, iconUrl } =
    rideType;

  const formattedPrice = `${currencySymbol}${estimatedPrice.toFixed(2)}`;
  const accessibleLabel =
    `${name}: ${description}. ` +
    `Estimated arrival in ${estimatedMinutes} minute${estimatedMinutes !== 1 ? "s" : ""}. ` +
    `Price: ${formattedPrice}.` +
    (isSelected ? " Currently selected." : "");

  function handleClick() {
    onSelect(rideType);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(rideType);
    }
  }

  return (
    <div
      id={`ride-type-card-${id}`}
      role="radio"
      aria-checked={isSelected}
      aria-label={accessibleLabel}
      tabIndex={isSelected ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={`ride-type-card${isSelected ? " ride-type-card--selected" : ""}`}
    >
      {iconUrl && (
        // Icon is decorative — the aria-label on the container covers all info
        <img src={iconUrl} alt="" aria-hidden="true" className="ride-type-card__icon" />
      )}
      <span className="ride-type-card__name">{name}</span>
      <span aria-hidden="true" className="ride-type-card__eta">
        {estimatedMinutes} min
      </span>
      <span aria-hidden="true" className="ride-type-card__price">
        {formattedPrice}
      </span>
    </div>
  );
}
