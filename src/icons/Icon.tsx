import { ReactNode, SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  color?: string;
  strokeWidth?: number;
  viewBox?: string;
  fill?: string;
  children?: ReactNode;
}

export function Icon({
  size = 16,
  color = "currentColor",
  strokeWidth = 1.4,
  fill = "none",
  viewBox = "0 0 16 16",
  children,
  style,
  ...rest
}: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill={fill}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, display: "block", ...style }}
      {...rest}
    >
      {children}
    </svg>
  );
}
