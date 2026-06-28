import React from 'react';

export interface DonutSlice { label: string; value: number; color: string; }

interface Props {
  data: DonutSlice[];
  size?: number;
  thickness?: number;
}

const DonutChart: React.FC<Props> = ({ data, size = 180, thickness = 28 }) => {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {total === 0 ? (
            <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="#eee" strokeWidth={thickness} />
          ) : data.map((d, i) => {
            const fraction = d.value / total;
            const dash = fraction * circumference;
            const el = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke={d.color}
                strokeWidth={thickness}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-offset}
              />
            );
            offset += dash;
            return el;
          })}
        </g>
        <text x="50%" y="50%" textAnchor="middle" dominantBaseline="middle" style={{ fontSize: '1.3rem', fontWeight: 'bold', fill: '#333' }}>
          {total}
        </text>
      </svg>
      <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', justifyContent: 'center' }}>
        {data.map((d, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.8rem', color: '#555' }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: d.color, display: 'inline-block' }} />
            {d.label} ({d.value})
          </div>
        ))}
      </div>
    </div>
  );
};

export default DonutChart;
