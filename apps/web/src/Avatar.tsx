export function Avatar({ name, picture, size = 32 }: { name: string; picture?: string; size?: number }) {
  return picture ? (
    <img className="avatar" src={picture} alt="" width={size} height={size} />
  ) : (
    <span className="avatar avatar-fallback" style={{ width: size, height: size }} aria-hidden>
      {name.slice(0, 1)}
    </span>
  );
}
