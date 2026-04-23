import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { RideTypeCarousel } from "../RideTypeCarousel.js";
import type { RideType } from "../../types.js";

const MOCK_RIDE_TYPES: RideType[] = [
  {
    id: "economy",
    name: "Economy",
    description: "Affordable everyday rides",
    estimatedMinutes: 3,
    estimatedPrice: 8.5,
    currencySymbol: "$",
  },
  {
    id: "comfort",
    name: "Comfort",
    description: "More legroom, top-rated drivers",
    estimatedMinutes: 5,
    estimatedPrice: 14.0,
    currencySymbol: "$",
  },
  {
    id: "xl",
    name: "XL",
    description: "Room for 6 passengers",
    estimatedMinutes: 7,
    estimatedPrice: 20.0,
    currencySymbol: "$",
  },
];

describe("RideTypeCarousel — accessibility", () => {
  test("renders a radiogroup with the correct accessible label", () => {
    render(
      <RideTypeCarousel
        rideTypes={MOCK_RIDE_TYPES}
        onSelect={jest.fn()}
        label="Choose a ride type"
      />,
    );

    const group = screen.getByRole("radiogroup");
    expect(group).toBeInTheDocument();

    // The heading referenced by aria-labelledby should be present
    const heading = screen.getByText("Choose a ride type");
    expect(heading).toBeInTheDocument();
  });

  test("each card has a descriptive aria-label containing name, ETA, and price", () => {
    render(<RideTypeCarousel rideTypes={MOCK_RIDE_TYPES} onSelect={jest.fn()} />);

    // Economy card
    const economyCard = screen.getByRole("radio", { name: /Economy/i });
    expect(economyCard).toHaveAttribute("aria-label", expect.stringContaining("Economy"));
    expect(economyCard).toHaveAttribute("aria-label", expect.stringContaining("3 minute"));
    expect(economyCard).toHaveAttribute("aria-label", expect.stringContaining("$8.50"));

    // Comfort card
    const comfortCard = screen.getByRole("radio", { name: /Comfort/i });
    expect(comfortCard).toHaveAttribute("aria-label", expect.stringContaining("Comfort"));
    expect(comfortCard).toHaveAttribute("aria-label", expect.stringContaining("5 minute"));
    expect(comfortCard).toHaveAttribute("aria-label", expect.stringContaining("$14.00"));

    // XL card
    const xlCard = screen.getByRole("radio", { name: /XL/i });
    expect(xlCard).toHaveAttribute("aria-label", expect.stringContaining("XL"));
    expect(xlCard).toHaveAttribute("aria-label", expect.stringContaining("7 minute"));
    expect(xlCard).toHaveAttribute("aria-label", expect.stringContaining("$20.00"));
  });

  test("selected card has aria-checked=true, unselected cards have aria-checked=false", () => {
    render(
      <RideTypeCarousel
        rideTypes={MOCK_RIDE_TYPES}
        selectedId="comfort"
        onSelect={jest.fn()}
      />,
    );

    const economyCard = screen.getByRole("radio", { name: /Economy/i });
    const comfortCard = screen.getByRole("radio", { name: /Comfort/i });
    const xlCard = screen.getByRole("radio", { name: /XL/i });

    expect(economyCard).toHaveAttribute("aria-checked", "false");
    expect(comfortCard).toHaveAttribute("aria-checked", "true");
    expect(xlCard).toHaveAttribute("aria-checked", "false");
  });

  test("selected card aria-label includes 'Currently selected'", () => {
    render(
      <RideTypeCarousel
        rideTypes={MOCK_RIDE_TYPES}
        selectedId="xl"
        onSelect={jest.fn()}
      />,
    );

    const xlCard = screen.getByRole("radio", { name: /XL/i });
    expect(xlCard).toHaveAttribute("aria-label", expect.stringContaining("Currently selected"));
  });

  test("clicking a card calls onSelect with the correct ride type", () => {
    const handleSelect = jest.fn();
    render(<RideTypeCarousel rideTypes={MOCK_RIDE_TYPES} onSelect={handleSelect} />);

    const economyCard = screen.getByRole("radio", { name: /Economy/i });
    fireEvent.click(economyCard);

    expect(handleSelect).toHaveBeenCalledTimes(1);
    expect(handleSelect).toHaveBeenCalledWith(MOCK_RIDE_TYPES[0]);
  });

  test("pressing Enter on a card calls onSelect", () => {
    const handleSelect = jest.fn();
    render(<RideTypeCarousel rideTypes={MOCK_RIDE_TYPES} onSelect={handleSelect} />);

    const comfortCard = screen.getByRole("radio", { name: /Comfort/i });
    fireEvent.keyDown(comfortCard, { key: "Enter" });

    expect(handleSelect).toHaveBeenCalledWith(MOCK_RIDE_TYPES[1]);
  });

  test("pressing Space on a card calls onSelect", () => {
    const handleSelect = jest.fn();
    render(<RideTypeCarousel rideTypes={MOCK_RIDE_TYPES} onSelect={handleSelect} />);

    const xlCard = screen.getByRole("radio", { name: /XL/i });
    fireEvent.keyDown(xlCard, { key: " " });

    expect(handleSelect).toHaveBeenCalledWith(MOCK_RIDE_TYPES[2]);
  });

  test("ride card icons are hidden from accessibility tree", () => {
    const rideTypesWithIcons: RideType[] = MOCK_RIDE_TYPES.map((rt) => ({
      ...rt,
      iconUrl: `https://example.com/icons/${rt.id}.png`,
    }));

    render(<RideTypeCarousel rideTypes={rideTypesWithIcons} onSelect={jest.fn()} />);

    // Images should be aria-hidden so they don't pollute the accessible name
    const images = document.querySelectorAll("img");
    images.forEach((img) => {
      expect(img).toHaveAttribute("aria-hidden", "true");
      expect(img).toHaveAttribute("alt", "");
    });
  });

  test("renders with no selection when selectedId is undefined", () => {
    render(<RideTypeCarousel rideTypes={MOCK_RIDE_TYPES} onSelect={jest.fn()} />);

    const cards = screen.getAllByRole("radio");
    cards.forEach((card) => {
      expect(card).toHaveAttribute("aria-checked", "false");
    });
  });
});
