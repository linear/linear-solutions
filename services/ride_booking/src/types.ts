export interface RideType {
  id: string;
  name: string;
  description: string;
  estimatedMinutes: number;
  estimatedPrice: number;
  currencySymbol: string;
  iconUrl?: string;
}

export interface RideTypeCarouselProps {
  rideTypes: RideType[];
  selectedId?: string;
  onSelect: (rideType: RideType) => void;
  label?: string;
}

export interface RideTypeCardProps {
  rideType: RideType;
  isSelected: boolean;
  onSelect: (rideType: RideType) => void;
}
