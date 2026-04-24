/**
 * AnimatedCharacters — ported from arsh342/careercompass.
 * Source: src/components/ui/animated-characters.tsx (MIT-style).
 *
 * Four cartoon characters (purple / black / orange / yellow) that:
 *   - track the mouse cursor (eyes + body skew)
 *   - blink randomly
 *   - look at each other when the login form is being typed in
 *   - purple character peeks mischievously at the visible password
 *   - all characters turn away when the password is masked
 *
 * Port notes:
 *   - Replaced "use client" directive (Next.js) — not needed in Vite/CRA
 *   - Replaced Tailwind utility classes with plain inline styles +
 *     minimal className so the component doesn't require a Tailwind
 *     config; visuals are identical
 *   - Everything inside one file for drop-in use
 */

import { useState, useEffect, useRef } from "react";

// ─── Pupil ──────────────────────────────────────────────────────────────

interface PupilProps {
  size?: number;
  maxDistance?: number;
  pupilColor?: string;
  forceLookX?: number;
  forceLookY?: number;
}

export const Pupil = ({
  size = 12,
  maxDistance = 5,
  pupilColor = "black",
  forceLookX,
  forceLookY,
}: PupilProps) => {
  const [mouseX, setMouseX] = useState<number>(0);
  const [mouseY, setMouseY] = useState<number>(0);
  const pupilRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMouseX(e.clientX);
      setMouseY(e.clientY);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  const calculatePupilPosition = () => {
    if (!pupilRef.current) return { x: 0, y: 0 };
    if (forceLookX !== undefined && forceLookY !== undefined) {
      return { x: forceLookX, y: forceLookY };
    }
    const pupil = pupilRef.current.getBoundingClientRect();
    const pupilCenterX = pupil.left + pupil.width / 2;
    const pupilCenterY = pupil.top + pupil.height / 2;
    const deltaX = mouseX - pupilCenterX;
    const deltaY = mouseY - pupilCenterY;
    const distance = Math.min(Math.sqrt(deltaX ** 2 + deltaY ** 2), maxDistance);
    const angle = Math.atan2(deltaY, deltaX);
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
  };

  const p = calculatePupilPosition();
  return (
    <div
      ref={pupilRef}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        borderRadius: "50%",
        backgroundColor: pupilColor,
        transform: `translate(${p.x}px, ${p.y}px)`,
        transition: "transform 0.1s ease-out",
      }}
    />
  );
};

// ─── EyeBall ────────────────────────────────────────────────────────────

interface EyeBallProps {
  size?: number;
  pupilSize?: number;
  maxDistance?: number;
  eyeColor?: string;
  pupilColor?: string;
  isBlinking?: boolean;
  forceLookX?: number;
  forceLookY?: number;
}

export const EyeBall = ({
  size = 48,
  pupilSize = 16,
  maxDistance = 10,
  eyeColor = "white",
  pupilColor = "black",
  isBlinking = false,
  forceLookX,
  forceLookY,
}: EyeBallProps) => {
  const [mouseX, setMouseX] = useState<number>(0);
  const [mouseY, setMouseY] = useState<number>(0);
  const eyeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMouseX(e.clientX);
      setMouseY(e.clientY);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  const calculatePupilPosition = () => {
    if (!eyeRef.current) return { x: 0, y: 0 };
    if (forceLookX !== undefined && forceLookY !== undefined) {
      return { x: forceLookX, y: forceLookY };
    }
    const eye = eyeRef.current.getBoundingClientRect();
    const eyeCenterX = eye.left + eye.width / 2;
    const eyeCenterY = eye.top + eye.height / 2;
    const deltaX = mouseX - eyeCenterX;
    const deltaY = mouseY - eyeCenterY;
    const distance = Math.min(Math.sqrt(deltaX ** 2 + deltaY ** 2), maxDistance);
    const angle = Math.atan2(deltaY, deltaX);
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
  };

  const p = calculatePupilPosition();
  return (
    <div
      ref={eyeRef}
      style={{
        width: `${size}px`,
        height: isBlinking ? "2px" : `${size}px`,
        borderRadius: "50%",
        backgroundColor: eyeColor,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "all 0.15s",
        overflow: "hidden",
      }}
    >
      {!isBlinking && (
        <div
          style={{
            width: `${pupilSize}px`,
            height: `${pupilSize}px`,
            borderRadius: "50%",
            backgroundColor: pupilColor,
            transform: `translate(${p.x}px, ${p.y}px)`,
            transition: "transform 0.1s ease-out",
          }}
        />
      )}
    </div>
  );
};

// ─── AnimatedCharacters ─────────────────────────────────────────────────

interface AnimatedCharactersProps {
  isTyping?: boolean;
  showPassword?: boolean;
  passwordLength?: number;
}

export function AnimatedCharacters({
  isTyping = false,
  showPassword = false,
  passwordLength = 0,
}: AnimatedCharactersProps) {
  const [mouseX, setMouseX] = useState<number>(0);
  const [mouseY, setMouseY] = useState<number>(0);
  const [isPurpleBlinking, setIsPurpleBlinking] = useState(false);
  const [isBlackBlinking, setIsBlackBlinking] = useState(false);
  const [isLookingAtEachOther, setIsLookingAtEachOther] = useState(false);
  const [isPurplePeeking, setIsPurplePeeking] = useState(false);
  const purpleRef = useRef<HTMLDivElement>(null);
  const blackRef = useRef<HTMLDivElement>(null);
  const yellowRef = useRef<HTMLDivElement>(null);
  const orangeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      setMouseX(e.clientX);
      setMouseY(e.clientY);
    };
    window.addEventListener("mousemove", handleMouseMove);
    return () => window.removeEventListener("mousemove", handleMouseMove);
  }, []);

  // Blinking — purple character
  useEffect(() => {
    const scheduleBlink = (): ReturnType<typeof setTimeout> => {
      return setTimeout(() => {
        setIsPurpleBlinking(true);
        setTimeout(() => {
          setIsPurpleBlinking(false);
          scheduleBlink();
        }, 150);
      }, Math.random() * 4000 + 3000);
    };
    const t = scheduleBlink();
    return () => clearTimeout(t);
  }, []);

  // Blinking — black character
  useEffect(() => {
    const scheduleBlink = (): ReturnType<typeof setTimeout> => {
      return setTimeout(() => {
        setIsBlackBlinking(true);
        setTimeout(() => {
          setIsBlackBlinking(false);
          scheduleBlink();
        }, 150);
      }, Math.random() * 4000 + 3000);
    };
    const t = scheduleBlink();
    return () => clearTimeout(t);
  }, []);

  // Look-at-each-other when typing begins
  useEffect(() => {
    if (isTyping) {
      setIsLookingAtEachOther(true);
      const timer = setTimeout(() => setIsLookingAtEachOther(false), 800);
      return () => clearTimeout(timer);
    } else {
      setIsLookingAtEachOther(false);
    }
  }, [isTyping]);

  // Purple peeks at visible password
  useEffect(() => {
    if (passwordLength > 0 && showPassword) {
      const peekInterval = setTimeout(() => {
        setIsPurplePeeking(true);
        setTimeout(() => setIsPurplePeeking(false), 800);
      }, Math.random() * 3000 + 2000);
      return () => clearTimeout(peekInterval);
    } else {
      setIsPurplePeeking(false);
    }
  }, [passwordLength, showPassword, isPurplePeeking]);

  const calculatePosition = (ref: React.RefObject<HTMLDivElement | null>) => {
    if (!ref.current) return { faceX: 0, faceY: 0, bodySkew: 0 };
    const rect = ref.current.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 3;
    const deltaX = mouseX - centerX;
    const deltaY = mouseY - centerY;
    const faceX = Math.max(-15, Math.min(15, deltaX / 20));
    const faceY = Math.max(-10, Math.min(10, deltaY / 30));
    const bodySkew = Math.max(-6, Math.min(6, -deltaX / 120));
    return { faceX, faceY, bodySkew };
  };

  const purplePos = calculatePosition(purpleRef);
  const blackPos = calculatePosition(blackRef);
  const yellowPos = calculatePosition(yellowRef);
  const orangePos = calculatePosition(orangeRef);

  const isHidingPassword = passwordLength > 0 && !showPassword;

  return (
    <div style={{ position: "relative", width: "550px", height: "400px" }}>
      {/* Purple tall rectangle — back layer */}
      <div
        ref={purpleRef}
        style={{
          position: "absolute",
          bottom: 0,
          left: "70px",
          width: "180px",
          height: isTyping || isHidingPassword ? "440px" : "400px",
          backgroundColor: "#6C3FF5",
          borderRadius: "10px 10px 0 0",
          zIndex: 1,
          transform:
            passwordLength > 0 && showPassword
              ? `skewX(0deg)`
              : isTyping || isHidingPassword
                ? `skewX(${(purplePos.bodySkew || 0) - 12}deg) translateX(40px)`
                : `skewX(${purplePos.bodySkew || 0}deg)`,
          transformOrigin: "bottom center",
          transition: "all 0.7s ease-in-out",
        }}
      >
        <div
          style={{
            position: "absolute",
            display: "flex",
            gap: "32px",
            left:
              passwordLength > 0 && showPassword
                ? `20px`
                : isLookingAtEachOther
                  ? `55px`
                  : `${45 + purplePos.faceX}px`,
            top:
              passwordLength > 0 && showPassword
                ? `35px`
                : isLookingAtEachOther
                  ? `65px`
                  : `${40 + purplePos.faceY}px`,
            transition: "all 0.7s ease-in-out",
          }}
        >
          <EyeBall
            size={18}
            pupilSize={7}
            maxDistance={5}
            eyeColor="white"
            pupilColor="#2D2D2D"
            isBlinking={isPurpleBlinking}
            forceLookX={
              passwordLength > 0 && showPassword
                ? isPurplePeeking ? 4 : -4
                : isLookingAtEachOther ? 3 : undefined
            }
            forceLookY={
              passwordLength > 0 && showPassword
                ? isPurplePeeking ? 5 : -4
                : isLookingAtEachOther ? 4 : undefined
            }
          />
          <EyeBall
            size={18}
            pupilSize={7}
            maxDistance={5}
            eyeColor="white"
            pupilColor="#2D2D2D"
            isBlinking={isPurpleBlinking}
            forceLookX={
              passwordLength > 0 && showPassword
                ? isPurplePeeking ? 4 : -4
                : isLookingAtEachOther ? 3 : undefined
            }
            forceLookY={
              passwordLength > 0 && showPassword
                ? isPurplePeeking ? 5 : -4
                : isLookingAtEachOther ? 4 : undefined
            }
          />
        </div>
      </div>

      {/* Black tall rectangle — middle layer */}
      <div
        ref={blackRef}
        style={{
          position: "absolute",
          bottom: 0,
          left: "240px",
          width: "120px",
          height: "310px",
          backgroundColor: "#2D2D2D",
          borderRadius: "8px 8px 0 0",
          zIndex: 2,
          transform:
            passwordLength > 0 && showPassword
              ? `skewX(0deg)`
              : isLookingAtEachOther
                ? `skewX(${(blackPos.bodySkew || 0) * 1.5 + 10}deg) translateX(20px)`
                : isTyping || isHidingPassword
                  ? `skewX(${(blackPos.bodySkew || 0) * 1.5}deg)`
                  : `skewX(${blackPos.bodySkew || 0}deg)`,
          transformOrigin: "bottom center",
          transition: "all 0.7s ease-in-out",
        }}
      >
        <div
          style={{
            position: "absolute",
            display: "flex",
            gap: "24px",
            left:
              passwordLength > 0 && showPassword
                ? `10px`
                : isLookingAtEachOther
                  ? `32px`
                  : `${26 + blackPos.faceX}px`,
            top:
              passwordLength > 0 && showPassword
                ? `28px`
                : isLookingAtEachOther
                  ? `12px`
                  : `${32 + blackPos.faceY}px`,
            transition: "all 0.7s ease-in-out",
          }}
        >
          <EyeBall
            size={16}
            pupilSize={6}
            maxDistance={4}
            eyeColor="white"
            pupilColor="#2D2D2D"
            isBlinking={isBlackBlinking}
            forceLookX={
              passwordLength > 0 && showPassword ? -4 : isLookingAtEachOther ? 0 : undefined
            }
            forceLookY={
              passwordLength > 0 && showPassword ? -4 : isLookingAtEachOther ? -4 : undefined
            }
          />
          <EyeBall
            size={16}
            pupilSize={6}
            maxDistance={4}
            eyeColor="white"
            pupilColor="#2D2D2D"
            isBlinking={isBlackBlinking}
            forceLookX={
              passwordLength > 0 && showPassword ? -4 : isLookingAtEachOther ? 0 : undefined
            }
            forceLookY={
              passwordLength > 0 && showPassword ? -4 : isLookingAtEachOther ? -4 : undefined
            }
          />
        </div>
      </div>

      {/* Orange semi-circle — front left */}
      <div
        ref={orangeRef}
        style={{
          position: "absolute",
          bottom: 0,
          left: "0px",
          width: "240px",
          height: "200px",
          zIndex: 3,
          backgroundColor: "#FF9B6B",
          borderRadius: "120px 120px 0 0",
          transform:
            passwordLength > 0 && showPassword
              ? `skewX(0deg)`
              : `skewX(${orangePos.bodySkew || 0}deg)`,
          transformOrigin: "bottom center",
          transition: "all 0.7s ease-in-out",
        }}
      >
        <div
          style={{
            position: "absolute",
            display: "flex",
            gap: "32px",
            left:
              passwordLength > 0 && showPassword
                ? `50px`
                : `${82 + (orangePos.faceX || 0)}px`,
            top:
              passwordLength > 0 && showPassword
                ? `85px`
                : `${90 + (orangePos.faceY || 0)}px`,
            transition: "all 0.2s ease-out",
          }}
        >
          <Pupil
            size={12}
            maxDistance={5}
            pupilColor="#2D2D2D"
            forceLookX={passwordLength > 0 && showPassword ? -5 : undefined}
            forceLookY={passwordLength > 0 && showPassword ? -4 : undefined}
          />
          <Pupil
            size={12}
            maxDistance={5}
            pupilColor="#2D2D2D"
            forceLookX={passwordLength > 0 && showPassword ? -5 : undefined}
            forceLookY={passwordLength > 0 && showPassword ? -4 : undefined}
          />
        </div>
      </div>

      {/* Yellow tall rectangle — front right */}
      <div
        ref={yellowRef}
        style={{
          position: "absolute",
          bottom: 0,
          left: "310px",
          width: "140px",
          height: "230px",
          backgroundColor: "#E8D754",
          borderRadius: "70px 70px 0 0",
          zIndex: 4,
          transform:
            passwordLength > 0 && showPassword
              ? `skewX(0deg)`
              : `skewX(${yellowPos.bodySkew || 0}deg)`,
          transformOrigin: "bottom center",
          transition: "all 0.7s ease-in-out",
        }}
      >
        <div
          style={{
            position: "absolute",
            display: "flex",
            gap: "24px",
            left:
              passwordLength > 0 && showPassword
                ? `20px`
                : `${52 + (yellowPos.faceX || 0)}px`,
            top:
              passwordLength > 0 && showPassword
                ? `35px`
                : `${40 + (yellowPos.faceY || 0)}px`,
            transition: "all 0.2s ease-out",
          }}
        >
          <Pupil
            size={12}
            maxDistance={5}
            pupilColor="#2D2D2D"
            forceLookX={passwordLength > 0 && showPassword ? -5 : undefined}
            forceLookY={passwordLength > 0 && showPassword ? -4 : undefined}
          />
          <Pupil
            size={12}
            maxDistance={5}
            pupilColor="#2D2D2D"
            forceLookX={passwordLength > 0 && showPassword ? -5 : undefined}
            forceLookY={passwordLength > 0 && showPassword ? -4 : undefined}
          />
        </div>
        {/* Mouth */}
        <div
          style={{
            position: "absolute",
            width: "80px",
            height: "4px",
            backgroundColor: "#2D2D2D",
            borderRadius: "9999px",
            left:
              passwordLength > 0 && showPassword
                ? `10px`
                : `${40 + (yellowPos.faceX || 0)}px`,
            top:
              passwordLength > 0 && showPassword
                ? `88px`
                : `${88 + (yellowPos.faceY || 0)}px`,
            transition: "all 0.2s ease-out",
          }}
        />
      </div>
    </div>
  );
}
