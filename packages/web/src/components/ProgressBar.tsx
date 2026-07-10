export interface ProgressBarProps {
  /** 0-100。undefined で不確定モード（スキャン中の往復アニメ）. */
  percent?: number;
}

export function ProgressBar({ percent }: ProgressBarProps) {
  const indeterminate = percent === undefined;
  return (
    <div className="hrb-progress">
      <div
        className={`hrb-progress__track ${indeterminate ? "hrb-progress__track--indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(indeterminate ? {} : { "aria-valuenow": percent })}
      >
        <div
          className="hrb-progress__bar"
          style={indeterminate ? undefined : { width: `${percent}%` }}
        />
      </div>
      {!indeterminate && <span className="hrb-progress__label">{percent}%</span>}
    </div>
  );
}
